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
async function addMember(
  storage: DatabaseHandle,
  ws: Workspace,
  suffix: string,
) {
  const userId = `${ws.tenantId}-${suffix}`;
  await storage.db.transaction().execute(async (tx) => {
    await tx
      .insertInto("users")
      .values({
        id: userId,
        subject: userId,
        display_name: suffix,
        created_at: Date.now(),
      })
      .execute();
    await tx
      .insertInto("memberships")
      .values({ tenant_id: ws.tenantId, user_id: userId, role: "founder" })
      .execute();
  });
  return { tenantId: ws.tenantId, userId };
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
 * Issue #23, acceptance 1: a normal backlog (long-running jobs with queued
 * work behind them) must keep delivery and log volume bounded. The scaled
 * variant exercises many windows quickly; the literal variant runs two jobs
 * longer than the real 60s liveness window.
 */
for (const variant of [
  {
    name: "scaled 150ms window",
    livenessMs: 150,
    pollMs: 50,
    leaseMs: 10_000,
    observeMs: 1500,
    waitingPerUser: 6,
  },
  {
    name: "literal 60s window",
    livenessMs: 60_000,
    pollMs: 200,
    leaseMs: 90_000,
    observeMs: 61_000,
    waitingPerUser: 6,
  },
] as const) {
  test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
    `P2 #23 normal backlog (${variant.name}): two long jobs block many queued runs without re-sending them`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "forge-backlog-"));
      const stderr = captureStderr();
      const storage = await openDatabase({
        dataDir: root,
        postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
      });
      const queue = new JobQueue(storage);
      const ws = await isolatedWorkspace(storage, "backlog");
      const userA = ws;
      const userB = await addMember(storage, ws, "second");
      let releaseLong: () => void = () => {};
      const longGate = new Promise<void>((resolve) => {
        releaseLong = resolve;
      });
      const executions = new Map<string, number>();
      const owners = new Map<string, Workspace>();
      let worker: ForgeWorker | undefined;
      try {
        worker = new ForgeWorker(
          queue,
          async (run) => {
            const payload = JSON.parse(run.input_json) as { long?: boolean };
            executions.set(run.id, (executions.get(run.id) ?? 0) + 1);
            if (payload.long) await longGate;
            return { state: "completed", result: { decision: "no-op" } };
          },
          {
            postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
            pollMs: variant.pollMs,
            leaseMs: variant.leaseMs,
            livenessMs: variant.livenessMs,
          },
        );
        await worker.start();
        // İki uzun iş ayrı gruplarda eşzamanlı yürür ve kapasiteyi tutar.
        const longA = await queue.accept(userA, {
          projectId: ws.projectId,
          kind: "skill_evolve",
          key: crypto.randomUUID(),
          payload: { long: true },
        });
        owners.set(longA.run.id, userA);
        await worker.sweepOutbox();
        await waitFor(
          async () =>
            (await queue.get(userA, longA.run.id)).state === "running",
          10_000,
        );
        const longB = await queue.accept(userB, {
          projectId: ws.projectId,
          kind: "skill_evolve",
          key: crypto.randomUUID(),
          payload: { long: true },
        });
        owners.set(longB.run.id, userB);
        await worker.sweepOutbox();
        const bothRunning = await waitFor(async () => {
          const states = await Promise.all([
            queue.get(userA, longA.run.id),
            queue.get(userB, longB.run.id),
          ]);
          return states.every((run) => run.state === "running");
        }, 10_000);
        expect(bothRunning).toBe(true);
        // Bekleyen işler aynı aktörün grup slotunu paylaşır: uzun iş bitmeden yürüyemezler.
        const waiting = [];
        for (let i = 0; i < variant.waitingPerUser; i += 1) {
          const owner = i % 2 === 0 ? userA : userB;
          const accepted = await queue.accept(owner, {
            projectId: ws.projectId,
            kind: "skill_evolve",
            key: crypto.randomUUID(),
            payload: { index: i },
          });
          owners.set(accepted.run.id, owner);
          waiting.push(accepted);
        }
        const waitingIds = waiting.map((item) => item.run.id);
        await worker.sweepOutbox();
        const delivered = await waitFor(async () => {
          const rows = await storage.db
            .selectFrom("outbox")
            .select(["run_id", "delivered"])
            .where("run_id", "in", waitingIds)
            .execute();
          return (
            rows.length === waitingIds.length &&
            rows.every((row) => row.delivered === 1)
          );
        }, 10_000);
        expect(delivered).toBe(true);
        const deliveredAt = new Map<string, number>();
        for (const runId of waitingIds)
          deliveredAt.set(
            runId,
            (await outboxRow(storage, runId)).delivered_at,
          );
        const logStart = stderr.chunks.length;
        // Backlog boyunca liveness pencereleri defalarca dolar.
        const observeUntil = Date.now() + variant.observeMs;
        while (Date.now() < observeUntil)
          await new Promise((r) => setTimeout(r, 200));
        for (const runId of waitingIds) {
          // Her bekleyen iş tam olarak bir kez gönderildi; pencere yenilendi.
          expect(await transportJobs(storage, runId)).toHaveLength(1);
          const row = await outboxRow(storage, runId);
          expect(row.delivery_attempts).toBe(1);
          expect(row.delivered).toBe(1);
          if (variant.observeMs > variant.livenessMs)
            expect(row.delivered_at).toBeGreaterThan(
              deliveredAt.get(runId)! + variant.livenessMs,
            );
        }
        expect(
          stderr.chunks
            .slice(logStart)
            .filter((chunk) => chunk.includes("teslim penceresi aştı")),
        ).toHaveLength(0);
        // Uzun işler bırakılır; bekleyen işler normal akışta birer kez yürür.
        releaseLong();
        const drained = await waitFor(async () => {
          const pending = await storage.db
            .selectFrom("runs")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("tenant_id", "=", ws.tenantId)
            .where("state", "not in", terminalStates)
            .executeTakeFirstOrThrow();
          return Number(pending.n) === 0;
        }, 30_000);
        expect(drained).toBe(true);
        for (const runId of [longA.run.id, longB.run.id, ...waitingIds]) {
          expect((await queue.get(owners.get(runId)!, runId)).state).toBe(
            "completed",
          );
          expect(executions.get(runId) ?? 0).toBe(1);
        }
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
    150_000,
  );
}
