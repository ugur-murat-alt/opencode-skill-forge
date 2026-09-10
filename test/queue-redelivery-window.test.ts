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
/** Shared test databases outlive one test; retire this test's nonterminal runs
 * so a later worker cannot claim them with the wrong handler. */
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
/** Remove this test's transport jobs so a later test process cannot fetch
 * them and consume its claim budget. */
async function purgeTransportJobs(storage: DatabaseHandle, tenantId: string) {
  await sql`
    delete from pgboss.job
    where singleton_key in (select id from runs where tenant_id = ${tenantId})
  `.execute(storage.db);
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

/**
 * Issue #23, acceptance 2: a queued record must not be re-sent on every sweep.
 * One successful send opens a fresh liveness window; while the pg-boss job is
 * still alive (created/retry/active) the sweep only renews that window.
 */
test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #23 redelivery window: 20 sweeps over an alive transport job keep one send and renew the window",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-redelivery-window-"));
    const stderr = captureStderr();
    const storage = await openDatabase({
      dataDir: root,
      postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
    });
    const queue = new JobQueue(storage);
    const ws = await isolatedWorkspace(storage, "window");
    let releaseLong: () => void = () => {};
    const longGate = new Promise<void>((resolve) => {
      releaseLong = resolve;
    });
    let worker: ForgeWorker | undefined;
    try {
      worker = new ForgeWorker(
        queue,
        async (run) => {
          const payload = JSON.parse(run.input_json) as { long?: boolean };
          if (payload.long) await longGate;
          return { state: "completed", result: { decision: "no-op" } };
        },
        {
          postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
          // The outbox loop must not add sweeps during the 20-sweep sequence.
          pollMs: 5000,
          leaseMs: 30_000,
          livenessMs: 50,
        },
      );
      await worker.start();
      // One long run occupies the only group slot for this actor, so the other
      // runs stay queued while their pg-boss jobs are still alive.
      const long = await queue.accept(ws, {
        projectId: ws.projectId,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { long: true },
      });
      await worker.sweepOutbox();
      await waitFor(
        async () => (await queue.get(ws, long.run.id)).state === "running",
        10_000,
      );
      expect((await queue.get(ws, long.run.id)).state).toBe("running");
      const acceptedAt = Date.now();
      const waiting = [];
      for (let i = 0; i < 3; i += 1)
        waiting.push(
          await queue.accept(ws, {
            projectId: ws.projectId,
            kind: "skill_evolve",
            key: crypto.randomUUID(),
            payload: { index: i },
          }),
        );
      const runIds = waiting.map((item) => item.run.id);
      await worker.sweepOutbox();
      const delivered = await waitFor(async () => {
        const rows = await storage.db
          .selectFrom("outbox")
          .select(["run_id", "delivered"])
          .where("run_id", "in", runIds)
          .execute();
        return (
          rows.length === runIds.length &&
          rows.every((row) => row.delivered === 1)
        );
      }, 10_000);
      expect(delivered).toBe(true);
      const logStart = stderr.chunks.length;
      for (let sweep = 0; sweep < 20; sweep += 1) {
        // Every iteration outlives the 50ms liveness window.
        await new Promise((r) => setTimeout(r, 60));
        await worker.sweepOutbox();
      }
      for (const runId of runIds) {
        // A healthy transport job is never re-sent, no matter how many windows pass.
        const jobs = await transportJobs(storage, runId);
        expect(jobs).toHaveLength(1);
        const row = await outboxRow(storage, runId);
        expect(row.delivery_attempts).toBe(1);
        // The single send opened windows that were renewed, not re-sent.
        expect(row.delivered_at).toBeGreaterThan(acceptedAt + 500);
      }
      expect(
        stderr.chunks
          .slice(logStart)
          .filter((chunk) => chunk.includes("teslim penceresi aştı")),
      ).toHaveLength(0);
    } finally {
      releaseLong();
      stderr.restore();
      await retireWorkspace(storage, ws.tenantId);
      await worker?.stop();
      await purgeTransportJobs(storage, ws.tenantId);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
