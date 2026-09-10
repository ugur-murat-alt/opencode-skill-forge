import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "kysely";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { JobQueue, terminalStates } from "../src/jobs/queue.js";
import { ForgeWorker } from "../src/jobs/worker.js";

interface Workspace {
  tenantId: string;
  userId: string;
  projectId: string;
}
async function isolatedWorkspace(
  storage: DatabaseHandle,
  tag: string,
): Promise<Workspace> {
  const tenantId = `w2-${tag}-${crypto.randomUUID().slice(0, 8)}`;
  const userId = `${tenantId}-owner`;
  const projectId = `${tenantId}-project`;
  const now = Date.now();
  await storage.db.transaction().execute(async (tx) => {
    await tx
      .insertInto("tenants")
      .values({ id: tenantId, name: tag, created_at: now })
      .execute();
    await tx
      .insertInto("users")
      .values({
        id: userId,
        subject: userId,
        display_name: tag,
        created_at: now,
      })
      .execute();
    await tx
      .insertInto("memberships")
      .values({ tenant_id: tenantId, user_id: userId, role: "founder" })
      .execute();
    await tx
      .insertInto("projects")
      .values({
        tenant_id: tenantId,
        id: projectId,
        name: tag,
        created_at: now,
      })
      .execute();
  });
  return { tenantId, userId, projectId };
}
async function transportJobs(storage: DatabaseHandle, runId: string) {
  const { rows } = await sql<{ id: string; state: string }>`
    select id, state from pgboss.job
    where name = 'skill_evolve' and singleton_key = ${runId}
    order by created_on, id
  `.execute(storage.db);
  return rows;
}
async function outboxRow(storage: DatabaseHandle, runId: string) {
  const { rows } = await sql<{
    delivered: number;
    delivered_at: number;
    delivery_attempts: number;
  }>`
    select delivered, delivered_at, delivery_attempts from outbox
    where run_id = ${runId}
  `.execute(storage.db);
  return rows[0]!;
}
function captureStderr() {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    chunks,
    restore: () => {
      process.stderr.write = original;
    },
  };
}
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 25,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return condition();
}
async function retireWorkspace(storage: DatabaseHandle, tenantId: string) {
  await storage.db
    .updateTable("runs")
    .set({
      state: "cancelled",
      lease_until: 0,
      updated_at: await storage.now(),
    })
    .where("tenant_id", "=", tenantId)
    .where("state", "not in", terminalStates)
    .execute();
}
async function purgeTransportJobs(storage: DatabaseHandle, tenantId: string) {
  await sql`
    delete from pgboss.job
    where singleton_key in (select id from runs where tenant_id = ${tenantId})
  `.execute(storage.db);
}

/**
 * Issue #23, acceptance 3: a real pg-boss retry exhaustion (not a simulated
 * state) must be observed while `runs` stays queued, and only then may a
 * deduplicated redelivery recover the run.
 */
test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #23 retry exhaustion: failed pg-boss job leaves runs queued, then one deduplicated redelivery recovers it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-exhaustion-"));
    const stderr = captureStderr();
    const storage = await openDatabase({
      dataDir: root,
      postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
    });
    const queue = new JobQueue(storage);
    const ws = await isolatedWorkspace(storage, "exhaust");
    const originalClaim = queue.claim.bind(queue);
    let admissionOpen = false;
    queue.claim = ((...args: Parameters<JobQueue["claim"]>) => {
      if (!admissionOpen) return Promise.reject(new Error("run_not_ready"));
      return originalClaim(...args);
    }) as JobQueue["claim"];
    const executions: string[] = [];
    let worker: ForgeWorker | undefined;
    try {
      worker = new ForgeWorker(
        queue,
        async (run) => {
          executions.push(run.id);
          return { state: "completed", result: { decision: "no-op" } };
        },
        {
          postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
          pollMs: 50,
          leaseMs: 5000,
          livenessMs: 1500,
        },
      );
      await worker.start();
      const accepted = await queue.accept(ws, {
        projectId: ws.projectId,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "Retry exhaustion" },
      });
      const runId = accepted.run.id;
      // Gerçek pg-boss tekrar bütçesi tükenene kadar yeniden teslim yok.
      const exhausted = await waitFor(
        async () =>
          (await transportJobs(storage, runId)).some(
            (job) => job.state === "failed",
          ),
        30_000,
        100,
      );
      expect(exhausted).toBe(true);
      const beforeRecovery = await transportJobs(storage, runId);
      expect(beforeRecovery).toHaveLength(1);
      expect(beforeRecovery[0]!.state).toBe("failed");
      // Uygulama doğruluk kaynağı hâlâ queued; taşıma hatası işi terminal yapmaz.
      expect((await queue.get(ws, runId)).state).toBe("queued");
      admissionOpen = true;
      const recovered = await waitFor(
        async () => (await queue.get(ws, runId)).state === "completed",
        30_000,
        100,
      );
      expect(recovered).toBe(true);
      // Tam olarak bir bounded yeniden teslim; yürütme ve fence tekil kalır.
      expect(await transportJobs(storage, runId)).toHaveLength(2);
      expect((await outboxRow(storage, runId)).delivery_attempts).toBe(2);
      expect(executions).toEqual([runId]);
      const attempts = await storage.db
        .selectFrom("run_attempts")
        .select(["fence", "result"])
        .where("tenant_id", "=", ws.tenantId)
        .where("run_id", "=", runId)
        .orderBy("fence")
        .execute();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.fence).toBe(1);
      // Operatör gözlemlenebilirliği: kayıp taşıma yeniden teslimi raporlanır.
      expect(
        stderr.chunks.filter((c) => c.includes("teslim penceresi aştı")),
      ).toHaveLength(1);
    } finally {
      stderr.restore();
      await retireWorkspace(storage, ws.tenantId);
      await worker?.stop();
      await purgeTransportJobs(storage, ws.tenantId);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  70_000,
);
