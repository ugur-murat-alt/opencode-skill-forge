import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { BudgetService } from "../src/jobs/budgets.js";
import { JobQueue } from "../src/jobs/queue.js";

const BACKENDS = [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const;

async function openTestDatabase(
  root: string,
  backend: (typeof BACKENDS)[number],
) {
  return openDatabase({
    dataDir: root,
    ...(backend === "postgres"
      ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
      : {}),
  });
}

/** A unique tenant/user keeps shared PostgreSQL runs free of cross-file state. */
async function isolatedOwner(storage: DatabaseHandle): Promise<Identity> {
  const identity = {
    tenantId: `budget-w2-${randomUUID()}`,
    userId: `budget-w2-user-${randomUUID()}`,
  };
  await storage.db.transaction().execute(async (tx) => {
    await tx
      .insertInto("users")
      .values({
        id: identity.userId,
        subject: identity.userId,
        display_name: "Budget test",
        created_at: Date.now(),
      })
      .execute();
    await tx
      .insertInto("tenants")
      .values({
        id: identity.tenantId,
        name: "Budget test",
        created_at: Date.now(),
      })
      .execute();
    await tx
      .insertInto("memberships")
      .values({
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        role: "founder",
      })
      .execute();
  });
  return identity;
}

async function acceptRun(
  storage: DatabaseHandle,
  owner: Identity,
  projectId: string,
  summary: string,
) {
  return new JobQueue(storage).accept(owner, {
    projectId,
    kind: "skill_evolve",
    key: randomUUID(),
    payload: { summary },
  });
}

for (const backend of BACKENDS) {
  const suffix = backend === "postgres" ? " (postgres)" : " (sqlite)";
  /** Issue #25: `maxCostMicros` is the accepted job's spending/reservation
   * limit. The user-wide account row is an accounting ledger, not a lifetime
   * quota derived from whichever job ran last. */
  test(`P2 #25 consecutive jobs each under the job limit are not rejected by a lifetime quota${suffix}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-budget-jobs-"));
    const storage = await openTestDatabase(root, backend);
    try {
      const owner = await isolatedOwner(storage);
      const project = await new IdentityService(storage.db).createProject(
        owner,
        "Job budgets",
      );
      const budget = new BudgetService(storage);
      await budget.reconcileAccount(owner, 1_000_000);
      const first = await acceptRun(storage, owner, project.id, "First job");
      const second = await acceptRun(storage, owner, project.id, "Second job");
      const firstReservation = randomUUID();
      await budget.reserve(
        owner,
        first.run.id,
        firstReservation,
        600_000,
        1_000_000,
      );
      await budget.settle(owner, firstReservation, 600_000);
      // The first job's 600_000 settled spending must not count against the
      // second job's own 1_000_000 limit.
      const secondReservation = randomUUID();
      await budget.reserve(
        owner,
        second.run.id,
        secondReservation,
        600_000,
        1_000_000,
      );
      await budget.settle(owner, secondReservation, 600_000);
      const summary = await budget.accountSummary(owner);
      expect(summary.spent_micros).toBe(1_200_000);
      expect(summary.reserved_micros).toBe(0);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  /** Issue #25, second scenario: spending in project A must not turn project
   * B's smaller job limit into an account quota. */
  test(`P2 #25 project policy change does not gate a new job with earlier project spending${suffix}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-budget-cross-project-"));
    const storage = await openTestDatabase(root, backend);
    try {
      const owner = await isolatedOwner(storage);
      const identities = new IdentityService(storage.db);
      const projectA = await identities.createProject(owner, "Project A");
      const projectB = await identities.createProject(owner, "Project B");
      const budget = new BudgetService(storage);
      await budget.reconcileAccount(owner, 2_000_000);
      const runA = await acceptRun(storage, owner, projectA.id, "A");
      const reservationA = randomUUID();
      await budget.reserve(
        owner,
        runA.run.id,
        reservationA,
        2_000_000,
        2_000_000,
      );
      await budget.settle(owner, reservationA, 2_000_000);
      // Project B policy: 500_000 per job.
      await budget.reconcileAccount(owner, 500_000);
      const runB = await acceptRun(storage, owner, projectB.id, "B");
      await budget.reserve(owner, runB.run.id, randomUUID(), 500_000, 500_000);
      const summary = await budget.accountSummary(owner);
      // A's real spending stays reported; it simply is not B's quota.
      expect(summary.spent_micros).toBe(2_000_000);
      expect(summary.reserved_micros).toBe(500_000);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  /** Issue #25: a normal in-flight reservation must not freeze the limit
   * update; already held accounting is preserved while new calls follow the
   * new limit. */
  test(`P2 #25 limit increase and decrease apply while calls are in flight${suffix}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-budget-revision-"));
    const storage = await openTestDatabase(root, backend);
    try {
      const owner = await isolatedOwner(storage);
      const project = await new IdentityService(storage.db).createProject(
        owner,
        "Revisions",
      );
      const budget = new BudgetService(storage);
      await budget.reconcileAccount(owner, 1_000_000);
      const run = await acceptRun(storage, owner, project.id, "In flight");
      const held = randomUUID();
      await budget.reserve(owner, run.run.id, held, 600_000, 1_000_000);
      // Decrease while the call is running: the new limit takes effect now.
      await budget.reconcileAccount(owner, 300_000);
      const decreased = await storage.db
        .selectFrom("budget_accounts")
        .select("limit_micros")
        .where("tenant_id", "=", owner.tenantId)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(decreased.limit_micros).toBe(300_000);
      // A new run is bounded by the decreased job limit.
      const next = await acceptRun(
        storage,
        owner,
        project.id,
        "After decrease",
      );
      await expect(
        budget.reserve(owner, next.run.id, randomUUID(), 300_001, 300_000),
      ).rejects.toMatchObject({ code: "budget_exhausted" });
      await budget.reserve(owner, next.run.id, randomUUID(), 300_000, 300_000);
      // The in-flight call settles with its real usage; accounting survives.
      await budget.settle(owner, held, 700_000);
      // Increase while another uncertain call is still held: it applies now.
      const uncertain = randomUUID();
      await budget.reserve(owner, run.run.id, uncertain, 100_000, 1_000_000);
      await budget.settle(owner, uncertain, null);
      await budget.reconcileAccount(owner, 2_000_000);
      const account = await storage.db
        .selectFrom("budget_accounts")
        .selectAll()
        .where("tenant_id", "=", owner.tenantId)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(account.limit_micros).toBe(2_000_000);
      expect(account.spent_micros).toBe(700_000);
      // 300_000 in-flight on the second run plus the 100_000 uncertain hold.
      expect(account.reserved_micros).toBe(400_000);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  /** Issue #25: normal in-flight and genuinely uncertain reservations are
   * reported separately, and an uncertain hold is only released through an
   * explicit, audited reconciliation with a recorded actual amount. */
  test(`P2 #25 uncertain reservations stay held until authorized reconciliation${suffix}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-budget-uncertain-"));
    const storage = await openTestDatabase(root, backend);
    try {
      const owner = await isolatedOwner(storage);
      const project = await new IdentityService(storage.db).createProject(
        owner,
        "Uncertain",
      );
      const budget = new BudgetService(storage);
      await budget.reconcileAccount(owner, 1_000_000);
      const run = await acceptRun(storage, owner, project.id, "Uncertain");
      const inFlight = randomUUID();
      const uncertain = randomUUID();
      await budget.reserve(owner, run.run.id, inFlight, 100_000, 1_000_000);
      await budget.reserve(owner, run.run.id, uncertain, 200_000, 1_000_000);
      await budget.settle(owner, uncertain, null);
      const summary = await budget.accountSummary(owner);
      expect(summary.reserved_micros).toBe(100_000);
      expect(summary.uncertain_micros).toBe(200_000);
      expect(summary.spent_micros).toBe(0);
      expect(summary.uncertain_reservations).toEqual([
        expect.objectContaining({
          id: uncertain,
          run_id: run.run.id,
          reserved_micros: 200_000,
        }),
      ]);
      // An uncertain hold alone never resets and never hides the amount: the
      // explicit recovery records the actual usage and keeps the audit trail.
      const resolved = await budget.resolveReservation(
        owner,
        uncertain,
        180_000,
      );
      expect(resolved.actual_micros).toBe(180_000);
      const after = await budget.accountSummary(owner);
      expect(after.reserved_micros).toBe(100_000);
      expect(after.uncertain_micros).toBe(0);
      expect(after.spent_micros).toBe(180_000);
      // Idempotent with the same amount, conflicting with a different one.
      await budget.resolveReservation(owner, uncertain, 180_000);
      await expect(
        budget.resolveReservation(owner, uncertain, 10_000),
      ).rejects.toMatchObject({ code: "settlement_conflict" });
      const audit = await storage.db
        .selectFrom("audit_events")
        .selectAll()
        .where("tenant_id", "=", owner.tenantId)
        .where("user_id", "=", owner.userId)
        .where("kind", "=", "budget.reservation_reconciled")
        .execute();
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!.detail)).toMatchObject({
        reservation_id: uncertain,
        previous_state: "unknown",
        reserved_micros: 200_000,
        actual_micros: 180_000,
      });
      // A foreign actor can never resolve this user's hold.
      const other = { tenantId: owner.tenantId, userId: "intruder" };
      await expect(
        budget.resolveReservation(other, inFlight, 1),
      ).rejects.toMatchObject({ code: "reservation_unavailable" });
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  /** Issue #25: concurrent settle and manual reconciliation of one hold are
   * serialized; the ledger must never count the same reservation down twice. */
  test(`P2 #25 concurrent settle and recovery resolve one hold exactly once${suffix}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-budget-race-"));
    const storage = await openTestDatabase(root, backend);
    try {
      const owner = await isolatedOwner(storage);
      const project = await new IdentityService(storage.db).createProject(
        owner,
        "Race",
      );
      const budget = new BudgetService(storage);
      await budget.reconcileAccount(owner, 1_000_000);
      const run = await acceptRun(storage, owner, project.id, "Race");
      const held = randomUUID();
      await budget.reserve(owner, run.run.id, held, 200_000, 1_000_000);
      const outcomes = await Promise.allSettled([
        budget.settle(owner, held, 150_000),
        budget.resolveReservation(owner, held, 180_000),
      ]);
      expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find(
        (x) => x.status === "rejected",
      ) as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "settlement_conflict" });
      const account = await storage.db
        .selectFrom("budget_accounts")
        .selectAll()
        .where("tenant_id", "=", owner.tenantId)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(account.reserved_micros).toBe(0);
      expect([150_000, 180_000]).toContain(account.spent_micros);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
