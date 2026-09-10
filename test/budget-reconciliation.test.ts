import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { BudgetService } from "../src/jobs/budgets.js";
import { JobQueue } from "../src/jobs/queue.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";

/** Issue #8 + #25: the job limit follows the current effective policy and
 * applies immediately, even while calls are in flight, because each run is
 * checked against its own accepted job limit. Reservations and settled
 * spending are accounting and are never reset by a policy revision. */
test("P2 #8/#25 job limit reconciles immediately while accounting is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-budget-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Budget");
    const budget = new BudgetService(storage);
    const queue = new JobQueue(storage);
    // İlk iş ücretsiz (0): hesap kurulur, limit 0.
    await budget.reconcileAccount(owner, 0);
    const first = await storage.db
      .selectFrom("budget_accounts")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .where("user_id", "=", owner.userId)
      .executeTakeFirst();
    expect(first!.limit_micros).toBe(0);
    await expect(
      budget.reserve(owner, "missing-run", crypto.randomUUID(), 5),
    ).rejects.toMatchObject({ code: "run_unavailable" });
    // Geçerli iş üzerinde rezervasyon denemesi (gerçek kabul yolu).
    const accepted = await queue.accept(owner, {
      projectId: project.id,
      kind: "skill_evolve",
      key: crypto.randomUUID(),
      payload: { summary: "Budget fixture" },
    });
    const runId = accepted.run.id;
    await expect(
      budget.reserve(owner, runId, crypto.randomUUID(), 5),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    // Politika ücretliye geçti: limit güncellenir.
    await budget.reconcileAccount(owner, 1_000_000);
    expect(
      (
        await storage.db
          .selectFrom("budget_accounts")
          .select("limit_micros")
          .where("tenant_id", "=", owner.tenantId)
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow()
      ).limit_micros,
    ).toBe(1_000_000);
    // Rezervasyon + gerçek harcama korunur.
    const reservation = crypto.randomUUID();
    await budget.reserve(owner, runId, reservation, 300_000, 1_000_000);
    await budget.settle(owner, reservation, 400_000);
    await budget.reconcileAccount(owner, 2_000_000);
    const after = await storage.db
      .selectFrom("budget_accounts")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .where("user_id", "=", owner.userId)
      .executeTakeFirstOrThrow();
    expect(after.limit_micros).toBe(2_000_000);
    expect(after.spent_micros).toBe(400_000);
    // Açık rezervasyon politika güncellemesini dondurmaz; tutarlar korunur.
    const pending = crypto.randomUUID();
    await budget.reserve(owner, runId, pending, 100_000, 2_000_000);
    await budget.reconcileAccount(owner, 5_000_000);
    const held = await storage.db
      .selectFrom("budget_accounts")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .where("user_id", "=", owner.userId)
      .executeTakeFirstOrThrow();
    expect(held.limit_micros).toBe(5_000_000);
    expect(held.reserved_micros).toBe(100_000);
    expect(held.spent_micros).toBe(400_000);
    await budget.settle(owner, pending, null);
    const uncertain = await storage.db
      .selectFrom("budget_accounts")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .where("user_id", "=", owner.userId)
      .executeTakeFirstOrThrow();
    // Belirsiz çağrı sıfırlanmaz; bekleyen tutar olarak kalır.
    expect(uncertain.reserved_micros).toBe(100_000);
    expect(uncertain.spent_micros).toBe(400_000);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #8/#25 overview reports job limit, in-flight, uncertain and spent separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-budget-ui-"));
  const cfg = await localConfig(root);
  const app = await createHttpServer(cfg);
  try {
    const base = { host: new URL(cfg.url).host, origin: cfg.url };
    const issued = await app.inject({
      method: "POST",
      url: "/api/pairing",
      headers: { ...base, authorization: `Bearer ${cfg.token}` },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/pair",
      headers: base,
      payload: { code: issued.json().code },
    });
    const cookie = loginRes.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const headers = {
      ...base,
      cookie,
      "x-forge-csrf": loginRes.json().csrf,
    };
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "Budget view" },
    });
    const jobLimit = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers,
      payload: {
        scope: "policy",
        base_revision: 0,
        values: { maxCostMicros: 1_234_000 },
      },
    });
    expect(jobLimit.statusCode).toBe(200);
    // Gerçek rezervasyon defteri: normal uçuştaki + belirsiz tutar.
    const { openDatabase } = await import("../src/storage/database.js");
    const live = await openDatabase({ dataDir: root });
    const queue = new JobQueue(live);
    const accepted = await queue.accept(
      { userId: "local-owner", tenantId: "local" },
      {
        projectId: project.json().id,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "Overview fixture" },
      },
    );
    const budget = new BudgetService(live);
    await budget.reconcileAccount(
      { userId: "local-owner", tenantId: "local" },
      1_234_000,
    );
    await budget.reserve(
      { userId: "local-owner", tenantId: "local" },
      accepted.run.id,
      crypto.randomUUID(),
      100_000,
      1_234_000,
    );
    const uncertain = crypto.randomUUID();
    await budget.reserve(
      { userId: "local-owner", tenantId: "local" },
      accepted.run.id,
      uncertain,
      200_000,
      1_234_000,
    );
    await budget.settle(
      { userId: "local-owner", tenantId: "local" },
      uncertain,
      null,
    );
    await live.close();
    const overview = await app.inject({
      url: `/api/overview?project_ref=${project.json().id}`,
      headers,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().account_budget).toMatchObject({
      job_limit_micros: 1_234_000,
      reserved_micros: 100_000,
      uncertain_micros: 200_000,
      spent_micros: 0,
    });
    expect(overview.json().account_budget.uncertain_reservations).toEqual([
      expect.objectContaining({
        id: uncertain,
        run_id: accepted.run.id,
        reserved_micros: 200_000,
      }),
    ]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
