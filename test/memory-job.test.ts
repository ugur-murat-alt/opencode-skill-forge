import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { ForgeWorker, type JobHandler } from "../src/jobs/worker.js";
import { MemoryService } from "../src/memory/service.js";
import { memoryJobHandlers } from "../src/memory/worker.js";
import {
  productionJobKinds,
  type ProductionJobKind,
} from "../src/memory/job-kinds.js";

/**
 * Issue #34 (M01): memory jobs ride the real shared queue and worker chain —
 * accept -> claim -> ForgeWorker(handlers) -> finish — with no skill model,
 * no provider profile and `evolutionEnabled=false`. Duplicate acceptance,
 * idempotency conflicts, personal/organization scopes and the unchanged
 * skill project+evolution gate are all exercised; the Postgres variant opens
 * its own throwaway database so no residue is left in the shared one.
 */

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

async function auditDetails(
  storage: DatabaseHandle,
  tenantId: string,
  kind: string,
) {
  const rows = await storage.db
    .selectFrom("audit_events")
    .select("detail")
    .where("tenant_id", "=", tenantId)
    .where("kind", "=", kind)
    .execute();
  return rows.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#34 memory jobs run without a model while skill gates stay intact (${backend})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-memory-job-"));
    let postgresUrl: string | undefined;
    let admin: PgClient | undefined;
    const databaseName = `forge_mem_job_${crypto.randomUUID().replaceAll("-", "")}`;
    if (backend === "postgres") {
      admin = new PgClient({
        connectionString: process.env.FORGE_TEST_POSTGRES_URL,
      });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
      url.pathname = `/${databaseName}`;
      postgresUrl = url.toString();
    }
    const storage = await openDatabase({
      dataDir: root,
      ...(postgresUrl ? { postgresUrl } : {}),
    });
    let worker: ForgeWorker<ProductionJobKind> | undefined;
    try {
      const identities = new IdentityService(storage.db);
      const owner = await identities.bootstrapLocal();
      const project = await identities.createProject(owner, "Skill projesi");
      const service = new MemoryService(storage.db);
      const personal = await service.ensureSpace(owner, { type: "personal" });
      const organization = await service.createOrganizationSpace(
        owner,
        "Ekip alanı",
      );
      // evolution kapalı, hafıza açık: iki bayrak bağımsız.
      const queue = new JobQueue<ProductionJobKind>(
        storage,
        { evolutionEnabled: false, memoryEnabled: true },
        productionJobKinds,
      );
      const ingestPayload = {
        spaceId: personal.id,
        sourceEventKey: "hook:1",
        sourceKind: "hook",
        contentHash: "a".repeat(64),
        observedAt: 1_700_000_000_000,
      };

      // 1. Skill türü proje + evolution kapısını korur.
      await expect(
        queue.accept(owner, {
          projectId: project.id,
          kind: "skill_evolve",
          key: crypto.randomUUID(),
          payload: { summary: "kapı" },
        }),
      ).rejects.toMatchObject({ code: "evolution_disabled", status: 422 });
      await expect(
        queue.accept(owner, {
          scope: { type: "personal" },
          kind: "skill_evolve",
          key: crypto.randomUUID(),
          payload: { summary: "kişisel skill" },
        }),
      ).rejects.toMatchObject({ code: "invalid_scope", status: 422 });

      // 2. memoryEnabled bağımsız kapıdır: evolution açıkken hafıza kapalıysa
      // hafıza reddedilir, skill kabul edilir (memoryEnabled onu etkilemez).
      const memoryOff = new JobQueue<ProductionJobKind>(
        storage,
        { evolutionEnabled: true, memoryEnabled: false },
        productionJobKinds,
      );
      await expect(
        memoryOff.accept(owner, {
          scope: { type: "personal" },
          kind: "memory_ingest",
          key: crypto.randomUUID(),
          payload: ingestPayload,
        }),
      ).rejects.toMatchObject({ code: "memory_disabled", status: 422 });
      const skillOn = await memoryOff.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "gözlemlenebilir" },
      });
      expect(skillOn.status).toBe("accepted");
      await memoryOff.cancel(owner, skillOn.run.id);

      // 3. Kapsam tam olarak bir kez verilir; sahte proje üretilmez.
      await expect(
        queue.accept(owner, {
          projectId: project.id,
          scope: { type: "project", projectId: project.id },
          kind: "memory_reconcile",
          key: crypto.randomUUID(),
          payload: {},
        }),
      ).rejects.toMatchObject({ code: "invalid_scope", status: 422 });
      await expect(
        queue.accept(owner, {
          kind: "memory_reconcile",
          key: crypto.randomUUID(),
          payload: {},
        } as never),
      ).rejects.toMatchObject({ code: "invalid_scope", status: 422 });

      // 4. Kişisel kapsamlı kalıcı olay kabulü: project_id null, scope_key
      // kullanıcı kimliği; evolutionEnabled=false kabulü engellemez.
      const ingestKey = crypto.randomUUID();
      const accepted = await queue.accept(owner, {
        scope: { type: "personal" },
        kind: "memory_ingest",
        key: ingestKey,
        payload: ingestPayload,
      });
      expect(accepted.status).toBe("accepted");
      expect(accepted.run.project_id).toBeNull();
      expect(accepted.run.scope_kind).toBe("personal");
      expect(accepted.run.scope_key).toBe(owner.userId);
      expect(accepted.run.config_json).not.toContain("providerProfile");
      const duplicate = await queue.accept(owner, {
        scope: { type: "personal" },
        kind: "memory_ingest",
        key: ingestKey,
        payload: ingestPayload,
      });
      expect(duplicate.status).toBe("duplicate");
      expect(duplicate.run.id).toBe(accepted.run.id);
      await expect(
        queue.accept(owner, {
          scope: { type: "personal" },
          kind: "memory_ingest",
          key: ingestKey,
          payload: { ...ingestPayload, contentHash: "d".repeat(64) },
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

      // 5. Gerçek zincir deterministik sırayla: worker önce açılır, orijinal
      // teslim tamamlanınca yeniden teslim ve çakışma işleri kabul edilir.
      // Aynı milisaniyede kabul edilen işlerin claim sırası UUID tie-break'e
      // bağlı olduğundan "hangi iş önce işlenir" bir sözleşme değildir.
      // Sözleşme şudur: tam olarak bir kayıt + bir duplicate, aynı event id,
      // tek event satırı; farklı hash ise çakışma olarak başarısız biter.
      const skillCalls: string[] = [];
      const skillHandler: JobHandler = async (run) => {
        skillCalls.push(run.id);
        return { state: "completed", result: { skill: true } };
      };
      worker = new ForgeWorker(queue, skillHandler, {
        ...(postgresUrl ? { postgresUrl } : {}),
        pollMs: 20,
        handlers: memoryJobHandlers(service),
      });
      await worker.start();
      const ingestSettled = await until(
        async () =>
          (await queue.get(owner, accepted.run.id)).state === "completed",
        25_000,
      );
      expect(ingestSettled).toBe(true);
      const events = await storage.db
        .selectFrom("memory_events")
        .selectAll()
        .where("tenant_id", "=", owner.tenantId)
        .execute();
      expect(events).toHaveLength(1);
      expect(events[0]!.space_id).toBe(personal.id);
      expect(
        JSON.parse((await queue.get(owner, accepted.run.id)).result_json!),
      ).toEqual({ status: "recorded", eventId: events[0]!.id });

      // 6. Aynı kaynağın yeniden teslimi yeni iş kimliğiyle duplicate döner;
      // farklı hash aynı anahtarla çakışma olarak başarısız biter.
      const redelivery = await queue.accept(owner, {
        scope: { type: "personal" },
        kind: "memory_ingest",
        key: crypto.randomUUID(),
        payload: ingestPayload,
      });
      const replaySettled = await until(
        async () =>
          (await queue.get(owner, redelivery.run.id)).state === "completed",
        25_000,
      );
      expect(replaySettled).toBe(true);
      expect(
        JSON.parse((await queue.get(owner, redelivery.run.id)).result_json!),
      ).toEqual({ status: "duplicate", eventId: events[0]!.id });
      expect(
        await storage.db
          .selectFrom("memory_events")
          .selectAll()
          .where("tenant_id", "=", owner.tenantId)
          .execute(),
      ).toHaveLength(1);

      const conflicting = await queue.accept(owner, {
        scope: { type: "personal" },
        kind: "memory_ingest",
        key: crypto.randomUUID(),
        payload: { ...ingestPayload, contentHash: "c".repeat(64) },
      });
      const conflictSettled = await until(
        async () =>
          (await queue.get(owner, conflicting.run.id)).state === "failed",
        25_000,
      );
      expect(conflictSettled).toBe(true);
      const conflictRun = await queue.get(owner, conflicting.run.id);
      expect(conflictRun.state).toBe("failed");
      expect(conflictRun.error_code).toBe("memory_event_conflict");
      expect(
        await storage.db
          .selectFrom("memory_events")
          .selectAll()
          .where("tenant_id", "=", owner.tenantId)
          .execute(),
      ).toHaveLength(1);

      // 7. Organizasyon kapsamlı uzlaştırma işi kayıttan sonra kabul edilir;
      // böylece rapor sayıları da iş sırasına bağlı olmaz.
      const reconcileRun = await queue.accept(owner, {
        scope: { type: "organization" },
        kind: "memory_reconcile",
        key: crypto.randomUUID(),
        payload: {},
      });
      expect(reconcileRun.run.project_id).toBeNull();
      expect(reconcileRun.run.scope_kind).toBe("organization");
      expect(reconcileRun.run.scope_key).toBe("organization");
      expect(JSON.parse(reconcileRun.run.input_json)).toEqual({ limit: 20 });
      const reconcileSettled = await until(
        async () =>
          (await queue.get(owner, reconcileRun.run.id)).state === "completed",
        25_000,
      );
      expect(reconcileSettled).toBe(true);
      expect(
        JSON.parse((await queue.get(owner, reconcileRun.run.id)).result_json!),
      ).toEqual({
        checked: 1,
        pending: 1,
        committed: 0,
        rejected: 0,
        conflicts: 0,
      });
      // Organizasyon alanına otomatik kopya düşmedi: kişisel olay yalnız
      // kişisel alanda kalır.
      expect(
        await storage.db
          .selectFrom("memory_events")
          .select(["id"])
          .where("space_id", "=", organization.id)
          .execute(),
      ).toHaveLength(0);
      // Duplicate kabul ikinci bir run/attempt üretmedi.
      const attempts = await queue.attempts(owner, accepted.run.id);
      expect(attempts.items).toHaveLength(1);
      expect(attempts.items[0]!.result).toBe("completed");
      const ingestRuns = await storage.db
        .selectFrom("runs")
        .select(["id"])
        .where("tenant_id", "=", owner.tenantId)
        .where("kind", "=", "memory_ingest")
        .execute();
      expect(ingestRuns).toHaveLength(3);
      // Skill handler hiç çağrılmadı: iptal edilen skill işi terminal.
      expect(skillCalls).toEqual([]);

      // 8. Audit duvarı hafıza işlerini de kapsar; accepted detayı kapsamı
      // taşır, finished detayı sonucu taşır.
      const acceptedAudit = await auditDetails(
        storage,
        owner.tenantId,
        "job.accepted",
      );
      expect(
        acceptedAudit.find((detail) => detail.run_id === accepted.run.id),
      ).toMatchObject({
        kind: "memory_ingest",
        scope_kind: "personal",
        scope_key: owner.userId,
      });
      const finishedAudit = await auditDetails(
        storage,
        owner.tenantId,
        "job.finished",
      );
      expect(
        finishedAudit.find((detail) => detail.run_id === reconcileRun.run.id),
      ).toMatchObject({ kind: "memory_reconcile", state: "completed" });
      expect(
        finishedAudit.find((detail) => detail.run_id === conflicting.run.id),
      ).toMatchObject({
        kind: "memory_ingest",
        state: "failed",
        error_code: "memory_event_conflict",
      });
      // Kişisel run'ın audit satırı kiracı/alan dışına taşmaz: yalnız bu
      // kiracının audit kayıtları sorgulandı.
      expect(
        await storage.db
          .selectFrom("audit_events")
          .select(["id"])
          .where("kind", "=", "job.accepted")
          .where("tenant_id", "!=", owner.tenantId)
          .execute(),
      ).toHaveLength(0);
    } finally {
      await worker?.stop();
      await storage.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
}
