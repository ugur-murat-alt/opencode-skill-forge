import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { BudgetService } from "../src/jobs/budgets.js";
import { ForgeWorker } from "../src/jobs/worker.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`durable jobs: ${backend} dedup, lease fencing, cancellation, reservation and real worker`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-jobs-"));
    const options = {
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    };
    const storage = await openDatabase(options);
    const identity = new IdentityService(storage.db);
    const owner = await identity.bootstrapLocal();
    const project = await identity.createProject(owner, "Job contract");
    const queue = new JobQueue(storage);
    let worker: ForgeWorker | undefined;
    try {
      const key = crypto.randomUUID();
      const payload = { summary: "Doğrulanmış tekrar kullanılabilir yöntem." };
      const accepts = await Promise.all(
        Array.from({ length: 10 }, () =>
          queue.accept(owner, {
            projectId: project.id,
            kind: "skill_evolve",
            key,
            payload,
          }),
        ),
      );
      expect(accepts.filter((x) => x.status === "accepted")).toHaveLength(1);
      expect(new Set(accepts.map((x) => x.run.id)).size).toBe(1);
      const accepted = accepts[0]!.run;
      await expect(
        queue.accept(owner, {
          projectId: project.id,
          kind: "skill_evolve",
          key,
          payload: { summary: "Different" },
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const first = await queue.claim("old-worker", 30, "skill_evolve", {
        tenantId: owner.tenantId,
        runId: accepted.id,
      });
      expect(first).not.toBeNull();
      await new Promise((r) => setTimeout(r, 45));
      const second = await queue.claim("new-worker", 10000, "skill_evolve", {
        tenantId: owner.tenantId,
        runId: accepted.id,
      });
      expect(second!.fence).toBe(2);
      await expect(queue.finish(first!, "completed", {})).rejects.toMatchObject(
        { code: "stale_worker" },
      );
      await queue.finish(second!, "no_op", { decision: "no-op" });
      expect((await queue.get(owner, accepted.id)).state).toBe("no_op");
      const cancelled = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { text: "Özgün" },
      });
      await queue.cancel(owner, cancelled.run.id);
      expect((await queue.get(owner, cancelled.run.id)).state).toBe(
        "cancelled",
      );
      await storage.db
        .insertInto("budget_accounts")
        .values({
          tenant_id: owner.tenantId,
          user_id: owner.userId,
          limit_micros: 100,
          reserved_micros: 0,
          spent_micros: 0,
        })
        .onConflict((oc) =>
          oc.columns(["tenant_id", "user_id"]).doUpdateSet({
            limit_micros: 100,
            reserved_micros: 0,
            spent_micros: 0,
          }),
        )
        .execute();
      const budgets = new BudgetService(storage),
        reservationA = crypto.randomUUID(),
        reservationB = crypto.randomUUID();
      const reserves = await Promise.allSettled([
        budgets.reserve(owner, accepted.id, reservationA, 70),
        budgets.reserve(owner, accepted.id, reservationB, 70),
      ]);
      expect(reserves.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const won = (
        reserves.find(
          (x) => x.status === "fulfilled",
        ) as PromiseFulfilledResult<{ id: string }>
      ).value;
      await budgets.settle(owner, won.id, null);
      expect(
        (
          await storage.db
            .selectFrom("budget_accounts")
            .selectAll()
            .where("tenant_id", "=", owner.tenantId)
            .where("user_id", "=", owner.userId)
            .executeTakeFirstOrThrow()
        ).reserved_micros,
      ).toBe(70);
      await budgets.settle(owner, won.id, 50);
      await budgets.settle(owner, won.id, 50);
      expect(
        (
          await storage.db
            .selectFrom("budget_accounts")
            .selectAll()
            .where("tenant_id", "=", owner.tenantId)
            .where("user_id", "=", owner.userId)
            .executeTakeFirstOrThrow()
        ).spent_micros,
      ).toBe(50);
      // Handler is explicitly deterministic test data; queue/worker/DB are real.
      worker = new ForgeWorker(
        queue,
        async () => ({
          state: "no_op",
          result: { decision: "no-op", fixture: true },
        }),
        { postgresUrl: options.postgresUrl, pollMs: 20 },
      );
      await worker.start();
      const item = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload,
      });
      const deadline = Date.now() + 10000;
      while (
        Date.now() < deadline &&
        (await queue.get(owner, item.run.id)).state !== "no_op"
      )
        await new Promise((r) => setTimeout(r, 50));
      expect((await queue.get(owner, item.run.id)).state).toBe("no_op");
    } finally {
      await worker?.stop();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
}
