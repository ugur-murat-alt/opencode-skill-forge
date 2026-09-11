import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue, terminalStates } from "../src/jobs/queue.js";
import {
  ForgeWorker,
  isRetryableWorkerError,
  type JobHandler,
} from "../src/jobs/worker.js";
import {
  defaultJobKinds,
  type JobKindDefinition,
} from "../src/domain/job-kinds.js";
import { ForgeError } from "../src/domain/errors.js";

/**
 * Issue #36 follow-up: concurrent SQLite writers (server + worker +
 * acceptance UI) can surface SQLITE_BUSY from a commit handler. Such a
 * transient database error must retry (bounded) instead of terminalizing the
 * run as worker_error; a genuine handler failure stays terminal.
 */
const fixtureKind: JobKindDefinition = {
  kind: "fixture_db_retry",
  payload: z.object({ note: z.string().min(1) }).strict(),
  skillProfile: false,
};
const kinds = {
  ...defaultJobKinds,
  fixture_db_retry: fixtureKind,
} as const;

const busy = () => {
  const error = new Error("database is locked") as Error & { code: string };
  error.code = "SQLITE_BUSY";
  return error;
};

async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-db-retry-"));
  const storage = await openDatabase({ dataDir: root });
  const identity = new IdentityService(storage.db);
  const owner = await identity.bootstrapLocal();
  const project = await identity.createProject(owner, "DB retry");
  const queue = new JobQueue(storage, {}, kinds);
  return { root, storage, owner, project, queue };
}

test("the retry classifier covers busy/locked and serialization codes", () => {
  expect(isRetryableWorkerError(busy())).toBe(true);
  expect(
    isRetryableWorkerError(
      Object.assign(new Error("serialization failure"), { code: "40001" }),
    ),
  ).toBe(true);
  expect(
    isRetryableWorkerError(
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    ),
  ).toBe(true);
  expect(isRetryableWorkerError(new Error("plain failure"))).toBe(false);
  expect(
    isRetryableWorkerError(
      new ForgeError(
        "memory_writer_busy",
        "Vault yazıcısı başka bir süreçte etkin.",
        409,
      ),
    ),
  ).toBe(true);
  expect(
    isRetryableWorkerError(
      Object.assign(new Error("missing column"), { code: "SQLITE_ERROR" }),
    ),
  ).toBe(false);
});

test("a busy-database failure retries and the run completes", async () => {
  const { root, storage, owner, project, queue } = await fixture();
  let calls = 0;
  let worker: ForgeWorker<string> | undefined;
  try {
    const handler: JobHandler = async () => {
      calls += 1;
      if (calls === 1) throw busy();
      return { state: "completed", result: { calls } };
    };
    worker = new ForgeWorker(queue, handler, { pollMs: 20 });
    await worker.start();
    const accepted = await queue.accept(owner, {
      projectId: project.id,
      kind: "fixture_db_retry",
      key: crypto.randomUUID(),
      payload: { note: "retry" },
    });
    const settled = await until(async () => {
      const run = await queue.get(owner, accepted.run.id);
      return terminalStates.includes(run.state);
    }, 15000);
    expect(settled).toBe(true);
    const run = await queue.get(owner, accepted.run.id);
    expect(run.state).toBe("completed");
    expect(calls).toBe(2);
    expect(run.attempt).toBe(2);
  } finally {
    await worker?.stop();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a plain handler failure stays terminal without retry", async () => {
  const { root, storage, owner, project, queue } = await fixture();
  let calls = 0;
  let worker: ForgeWorker<string> | undefined;
  try {
    const handler: JobHandler = async () => {
      calls += 1;
      throw new Error("genuine failure");
    };
    worker = new ForgeWorker(queue, handler, { pollMs: 20 });
    await worker.start();
    const accepted = await queue.accept(owner, {
      projectId: project.id,
      kind: "fixture_db_retry",
      key: crypto.randomUUID(),
      payload: { note: "terminal" },
    });
    const settled = await until(async () => {
      const run = await queue.get(owner, accepted.run.id);
      return terminalStates.includes(run.state);
    }, 15000);
    expect(settled).toBe(true);
    const run = await queue.get(owner, accepted.run.id);
    expect(run.state).toBe("failed");
    expect(run.error_code).toBe("worker_error");
    expect(calls).toBe(1);
  } finally {
    await worker?.stop();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
