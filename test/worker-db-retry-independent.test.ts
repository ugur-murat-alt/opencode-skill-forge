import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue, terminalStates } from "../src/jobs/queue.js";
import { ForgeWorker, isRetryableWorkerError } from "../src/jobs/worker.js";
import { defaultJobKinds } from "../src/domain/job-kinds.js";

/**
 * Bağımsız doğrulama (f5796d0): geçici veritabanı hataları işi terminal
 * yapmamalı, gerçek handler hataları terminal kalmalı. Gerçek kuyruk + worker
 * + SQLite; sahte stream/model yok.
 *
 * Sınıflama kuralı: SQLITE_BUSY/LOCKED ve PostgreSQL 40001/40P01 yeniden
 * dener; 23505 (benzersizlik) gibi gerçek hatalar ve ForgeError 4xx terminal.
 */

const retryProbeKind = {
  kind: "retry_probe",
  payload: z.record(z.string(), z.unknown()),
  skillProfile: false,
  scope: "memory",
} as const;

async function openEnv() {
  const root = await mkdtemp(join(tmpdir(), "forge-retry-ind-"));
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const kinds = { ...defaultJobKinds, retry_probe: retryProbeKind };
  const queue = new JobQueue(
    storage,
    { memoryEnabled: true, evolutionEnabled: false },
    kinds,
  );
  return {
    root,
    storage,
    owner,
    queue,
    kinds,
    close: async () => {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitTerminal(
  env: Awaited<ReturnType<typeof openEnv>>,
  runId: string,
  timeoutMs = 20000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await env.queue.get(env.owner, runId);
    if (terminalStates.includes(run.state)) return run;
    await new Promise((wait) => setTimeout(wait, 25));
  }
  throw new Error("run terminal duruma ulaşmadı");
}

test("SQLITE_BUSY ve PG 40001 yeniden denenir; gerçek hata terminal kalır", async () => {
  const env = await openEnv();
  let worker: ForgeWorker<string> | undefined;
  try {
    const counters = { busy: 0, serialization: 0, genuine: 0 };
    const handler = async (run: {
      id: string;
      kind: string;
      project_id: string | null;
    }) => {
      if (run.kind !== "retry_probe") throw new Error("beklenmeyen tür");
      if (run.project_id !== null) throw new Error("proje beklenmiyordu");
      counters.busy += 1;
      if (counters.busy <= 2)
        throw Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
        });
      return { state: "completed" as const, result: { ok: true } };
    };
    worker = new ForgeWorker(env.queue, handler as never, {
      pollMs: 20,
      handlers: {},
    });
    await worker.start();
    const accepted = await env.queue.accept(env.owner, {
      kind: "retry_probe",
      key: "busy-path",
      payload: {},
      scope: { type: "personal" },
    });
    const run = await waitTerminal(env, accepted.run.id, 30000);
    expect(run.state).toBe("completed");
    expect(run.attempt).toBe(3);
    expect(counters.busy).toBe(3);
    const attempts = await env.queue.attempts(env.owner, accepted.run.id);
    expect(attempts.items).toHaveLength(3);
    // Yeniden denenen turlar da kapanır (retry_wait) ve görünürlük
    // audit'teki job.retry_scheduled ile birlikte sağlanır.
    expect(attempts.items.map((item) => item.result)).toEqual([
      "retry_wait",
      "retry_wait",
      "completed",
    ]);
    const audits = await env.storage.db
      .selectFrom("audit_events")
      .select(["kind"])
      .where("tenant_id", "=", env.owner.tenantId)
      .where("kind", "in", ["job.retry_scheduled", "job.finished"])
      .execute();
    expect(
      audits.filter((row) => row.kind === "job.retry_scheduled"),
    ).toHaveLength(2);
    expect(audits.filter((row) => row.kind === "job.finished")).toHaveLength(1);
  } finally {
    await worker?.stop();
    await env.close();
  }
}, 60000);

test("PostgreSQL seri hale getirme kodu gerçek worker döngüsünde yeniden denenir", async () => {
  const env = await openEnv();
  let worker: ForgeWorker<string> | undefined;
  try {
    const counters = { serialization: 0 };
    const handler = async () => {
      counters.serialization += 1;
      if (counters.serialization === 1)
        throw Object.assign(new Error("could not serialize access"), {
          code: "40001",
        });
      return { state: "completed" as const, result: { ok: true } };
    };
    worker = new ForgeWorker(env.queue, handler as never, { pollMs: 20 });
    await worker.start();
    const accepted = await env.queue.accept(env.owner, {
      kind: "retry_probe",
      key: "pg-serialization",
      payload: {},
      scope: { type: "personal" },
    });
    const run = await waitTerminal(env, accepted.run.id, 20000);
    expect(run.state).toBe("completed");
    expect(run.attempt).toBe(2);
    expect(counters.serialization).toBe(2);
  } finally {
    await worker?.stop();
    await env.close();
  }
}, 60000);

test("gerçek handler hatası ilk denemede terminal olur, yeniden denenmez", async () => {
  const env = await openEnv();
  let worker: ForgeWorker<string> | undefined;
  try {
    const counters = { calls: 0 };
    worker = new ForgeWorker(
      env.queue,
      (async () => {
        counters.calls += 1;
        throw new Error("gerçek iş hatası");
      }) as never,
      { pollMs: 20 },
    );
    await worker.start();
    const accepted = await env.queue.accept(env.owner, {
      kind: "retry_probe",
      key: "genuine-failure",
      payload: {},
      scope: { type: "personal" },
    });
    const run = await waitTerminal(env, accepted.run.id, 15000);
    expect(run.state).toBe("failed");
    expect(run.error_code).toBe("worker_error");
    expect(run.attempt).toBe(1);
    expect(counters.calls).toBe(1);
    const attempts = await env.queue.attempts(env.owner, accepted.run.id);
    expect(attempts.items).toHaveLength(1);
    expect(attempts.items[0]!.result).toBe("failed");
  } finally {
    await worker?.stop();
    await env.close();
  }
}, 60000);

test("sınıflama: geçici kodlar dener, benzersizlik ihlali ve 4xx denemez", () => {
  for (const code of [
    "SQLITE_BUSY",
    "SQLITE_BUSY_SNAPSHOT",
    "SQLITE_LOCKED",
    "40001",
    "40P01",
  ]) {
    expect(
      isRetryableWorkerError(Object.assign(new Error("x"), { code })),
      code,
    ).toBe(true);
  }
  for (const code of ["23505", "SQLITE_CONSTRAINT_UNIQUE", "42P01"]) {
    expect(
      isRetryableWorkerError(Object.assign(new Error("x"), { code })),
      code,
    ).toBe(false);
  }
  expect(
    isRetryableWorkerError(new Error("database is locked: retry later")),
  ).toBe(true);
  expect(isRetryableWorkerError(new Error("boom"))).toBe(false);
});
