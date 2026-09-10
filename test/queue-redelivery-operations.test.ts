import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "kysely";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import type { Run } from "../src/storage/schema.js";
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
async function safeStop(worker?: ForgeWorker) {
  await worker?.stop().catch(() => undefined);
}
function setup() {
  return mkdtemp(join(tmpdir(), "forge-operations-"));
}
async function open(root: string) {
  const storage = await openDatabase({
    dataDir: root,
    postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
  });
  return { storage, queue: new JobQueue(storage) };
}

/**
 * Issue #23, acceptance 4: operational conditions must keep the liveness
 * contract. Two dispatchers share ownership, a restart recovers an expired
 * execution lease with fencing, cancel/frozen/deadline never spin.
 */
test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #23 two dispatchers: one owner per outbox row, exactly one send and one execution per run",
  async () => {
    const root = await setup();
    const { storage, queue } = await open(root);
    const ws = await isolatedWorkspace(storage, "dispatchers");
    const executions = new Map<string, number>();
    const workerA = new ForgeWorker(
      queue,
      async (run) => {
        executions.set(run.id, (executions.get(run.id) ?? 0) + 1);
        return { state: "completed", result: { decision: "no-op" } };
      },
      {
        postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
        pollMs: 50,
        leaseMs: 3000,
        livenessMs: 300,
      },
    );
    const workerB = new ForgeWorker(
      queue,
      async (run) => {
        executions.set(run.id, (executions.get(run.id) ?? 0) + 1);
        return { state: "completed", result: { decision: "no-op" } };
      },
      {
        postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
        pollMs: 50,
        leaseMs: 3000,
        livenessMs: 300,
      },
    );
    try {
      await workerA.start();
      await workerB.start();
      const accepted = [];
      for (let i = 0; i < 6; i += 1)
        accepted.push(
          await queue.accept(ws, {
            projectId: ws.projectId,
            kind: "skill_evolve",
            key: crypto.randomUUID(),
            payload: { index: i },
          }),
        );
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
      for (const item of accepted) {
        expect((await queue.get(ws, item.run.id)).state).toBe("completed");
        expect(executions.get(item.run.id) ?? 0).toBe(1);
        // Sahiplik: eşzamanlı iki dispatcher aynı kaydı ikinci kez göndermez.
        expect(await transportJobs(storage, item.run.id)).toHaveLength(1);
        expect((await outboxRow(storage, item.run.id)).delivery_attempts).toBe(
          1,
        );
      }
    } finally {
      await retireWorkspace(storage, ws.tenantId);
      await safeStop(workerA);
      await safeStop(workerB);
      await purgeTransportJobs(storage, ws.tenantId);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  40_000,
);

test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #23 restart: crashed executor lease expires, new worker re-delivers once with fencing",
  async () => {
    const root = await setup();
    const { storage, queue } = await open(root);
    const ws = await isolatedWorkspace(storage, "restart");
    let invocations = 0;
    let completions = 0;
    const handler = async (run: Run, signal: AbortSignal) => {
      const payload = JSON.parse(run.input_json) as { block?: boolean };
      invocations += 1;
      // Yalnızca çöken ilk yürütme asılı kalır; kurtaran worker tamamlar.
      if (payload.block && invocations === 1)
        await new Promise<void>((_, reject) => {
          if (signal.aborted) reject(new Error("stopped"));
          else
            signal.addEventListener(
              "abort",
              () => reject(new Error("stopped")),
              { once: true },
            );
        });
      completions += 1;
      return { state: "completed" as const, result: { decision: "no-op" } };
    };
    const worker1 = new ForgeWorker(queue, handler, {
      postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
      pollMs: 50,
      leaseMs: 300,
      livenessMs: 150,
    });
    const worker2 = new ForgeWorker(queue, handler, {
      postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
      pollMs: 50,
      leaseMs: 2000,
      livenessMs: 100,
    });
    try {
      await worker1.start();
      const accepted = await queue.accept(ws, {
        projectId: ws.projectId,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { block: true },
      });
      const runId = accepted.run.id;
      const claimed = await waitFor(
        async () => (await queue.get(ws, runId)).state === "running",
        10_000,
      );
      expect(claimed).toBe(true);
      expect(invocations).toBe(1);
      // Süreç çöker: lease yenilenmez, iş running kalır.
      await worker1.stop();
      expect((await queue.get(ws, runId)).state).toBe("running");
      await worker2.start();
      const recovered = await waitFor(
        async () => (await queue.get(ws, runId)).state === "completed",
        20_000,
      );
      expect(recovered).toBe(true);
      // Tek terminal tamamlanma; ilk yürütme lease_expired olarak kapanır.
      expect(completions).toBe(1);
      expect(invocations).toBe(2);
      const attempts = await storage.db
        .selectFrom("run_attempts")
        .select(["fence", "result"])
        .where("tenant_id", "=", ws.tenantId)
        .where("run_id", "=", runId)
        .orderBy("fence")
        .execute();
      expect(attempts.map((row) => row.fence)).toEqual([1, 2]);
      expect(attempts[0]!.result).toBe("lease_expired");
      expect(attempts[1]!.result).toBe("completed");
    } finally {
      await retireWorkspace(storage, ws.tenantId);
      await safeStop(worker1);
      await safeStop(worker2);
      await purgeTransportJobs(storage, ws.tenantId);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  40_000,
);

test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #23 expired lease: a running run whose executor lease died is re-delivered",
  async () => {
    const root = await setup();
    const { storage, queue } = await open(root);
    const ws = await isolatedWorkspace(storage, "lease");
    const executions: string[] = [];
    const worker = new ForgeWorker(
      queue,
      async (run) => {
        executions.push(run.id);
        return { state: "completed", result: { decision: "no-op" } };
      },
      {
        postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
        pollMs: 50,
        leaseMs: 1000,
        livenessMs: 100,
      },
    );
    try {
      const accepted = await queue.accept(ws, {
        projectId: ws.projectId,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "Lease" },
      });
      const runId = accepted.run.id;
      const ghost = await queue.claim("ghost-executor", 150, "skill_evolve", {
        tenantId: ws.tenantId,
        runId,
      });
      expect(ghost).not.toBeNull();
      await new Promise((r) => setTimeout(r, 250));
      await worker.start();
      const recovered = await waitFor(
        async () => (await queue.get(ws, runId)).state === "completed",
        15_000,
      );
      expect(recovered).toBe(true);
      expect(executions).toEqual([runId]);
      const attempts = await storage.db
        .selectFrom("run_attempts")
        .select(["fence", "result"])
        .where("tenant_id", "=", ws.tenantId)
        .where("run_id", "=", runId)
        .orderBy("fence")
        .execute();
      expect(attempts.map((row) => row.result)).toEqual([
        "lease_expired",
        "completed",
      ]);
    } finally {
      await retireWorkspace(storage, ws.tenantId);
      await safeStop(worker);
      await purgeTransportJobs(storage, ws.tenantId);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #23 cancel: a cancelled run is never delivered or executed",
  async () => {
    const root = await setup();
    const { storage, queue } = await open(root);
    const ws = await isolatedWorkspace(storage, "cancel");
    const executions: string[] = [];
    const worker = new ForgeWorker(
      queue,
      async (run) => {
        executions.push(run.id);
        return { state: "completed", result: { decision: "no-op" } };
      },
      {
        postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
        pollMs: 50,
        leaseMs: 1000,
        livenessMs: 100,
      },
    );
    try {
      const accepted = await queue.accept(ws, {
        projectId: ws.projectId,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "Cancel" },
      });
      await queue.cancel(ws, accepted.run.id);
      await worker.start();
      await new Promise((r) => setTimeout(r, 800));
      expect((await queue.get(ws, accepted.run.id)).state).toBe("cancelled");
      expect(executions).toHaveLength(0);
      expect(await transportJobs(storage, accepted.run.id)).toHaveLength(0);
    } finally {
      await retireWorkspace(storage, ws.tenantId);
      await safeStop(worker);
      await purgeTransportJobs(storage, ws.tenantId);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #23 frozen tenant: deliveries wait while frozen and resume after unfreeze",
  async () => {
    const root = await setup();
    const { storage, queue } = await open(root);
    const ws = await isolatedWorkspace(storage, "frozen");
    const executions: string[] = [];
    const worker = new ForgeWorker(
      queue,
      async (run) => {
        executions.push(run.id);
        return { state: "completed", result: { decision: "no-op" } };
      },
      {
        postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
        pollMs: 50,
        leaseMs: 1000,
        livenessMs: 100,
      },
    );
    try {
      const accepted = await queue.accept(ws, {
        projectId: ws.projectId,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "Frozen" },
      });
      await storage.db
        .insertInto("tenant_lifecycle")
        .values({
          tenant_id: ws.tenantId,
          frozen: 1,
          deletion_requested_at: null,
          deletion_requested_by: null,
        })
        .execute();
      await worker.start();
      await new Promise((r) => setTimeout(r, 800));
      expect((await queue.get(ws, accepted.run.id)).state).toBe("queued");
      expect(executions).toHaveLength(0);
      expect(await transportJobs(storage, accepted.run.id)).toHaveLength(0);
      await storage.db
        .updateTable("tenant_lifecycle")
        .set({ frozen: 0 })
        .where("tenant_id", "=", ws.tenantId)
        .execute();
      const recovered = await waitFor(
        async () =>
          (await queue.get(ws, accepted.run.id)).state === "completed",
        15_000,
      );
      expect(recovered).toBe(true);
      expect(executions).toEqual([accepted.run.id]);
      expect(await transportJobs(storage, accepted.run.id)).toHaveLength(1);
    } finally {
      await retireWorkspace(storage, ws.tenantId);
      await safeStop(worker);
      await purgeTransportJobs(storage, ws.tenantId);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #23 deadline: a delivery past deadline terminalizes without executing or looping",
  async () => {
    const root = await setup();
    const { storage, queue } = await open(root);
    const ws = await isolatedWorkspace(storage, "deadline");
    const executions: string[] = [];
    const worker = new ForgeWorker(
      queue,
      async (run) => {
        executions.push(run.id);
        return { state: "completed", result: { decision: "no-op" } };
      },
      {
        postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
        pollMs: 50,
        leaseMs: 1000,
        livenessMs: 100,
      },
    );
    try {
      const accepted = await queue.accept(ws, {
        projectId: ws.projectId,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "Deadline" },
        deadlineMs: 100,
      });
      await new Promise((r) => setTimeout(r, 250));
      await worker.start();
      const failed = await waitFor(
        async () => (await queue.get(ws, accepted.run.id)).state === "failed",
        15_000,
      );
      expect(failed).toBe(true);
      const run = await queue.get(ws, accepted.run.id);
      expect(run.error_code).toBe("deadline_or_attempt_limit");
      expect(executions).toHaveLength(0);
      // Tek teslim: terminal iş yeniden teslim edilmez.
      await new Promise((r) => setTimeout(r, 400));
      expect(await transportJobs(storage, accepted.run.id)).toHaveLength(1);
      expect(
        (await outboxRow(storage, accepted.run.id)).delivery_attempts,
      ).toBe(1);
    } finally {
      await retireWorkspace(storage, ws.tenantId);
      await safeStop(worker);
      await purgeTransportJobs(storage, ws.tenantId);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
