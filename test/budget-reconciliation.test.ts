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

/** Issue #8: the account limit must follow the CURRENT effective policy
 * through an explicit reconciliation, not freeze at the first job's value. */
test("P2 #8 account limit reconciles when idle and freezes under reservations", async () => {
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
    // Politika ücretliye geçti: boşta iken uzlaştırma limiti günceller.
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
    // Rezervasyon + gerçek harcama korunur; uzlaştırma onları sıfırlamaz.
    const reservation = crypto.randomUUID();
    await budget.reserve(owner, runId, reservation, 300_000);
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
    // Belirsiz provider çağrısı sırasında (rezervasyon açıkken) limit
    // değişmez; eski rezervasyonlar korunur.
    const pending = crypto.randomUUID();
    await budget.reserve(owner, runId, pending, 100_000);
    await budget.reconcileAccount(owner, 5_000_000);
    const held = await storage.db
      .selectFrom("budget_accounts")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .where("user_id", "=", owner.userId)
      .executeTakeFirstOrThrow();
    expect(held.limit_micros).toBe(2_000_000);
    expect(held.reserved_micros).toBe(100_000);
    expect(held.spent_micros).toBe(400_000);
    await budget.settle(owner, pending, null);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #8 overview separates job limit from account budget fields", async () => {
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
    const headers = { ...base, cookie, "x-forge-csrf": loginRes.json().csrf };
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "Budget view" },
    });
    const overview = await app.inject({
      url: `/api/overview?project_ref=${project.json().id}`,
      headers,
    });
    expect(overview.statusCode).toBe(200);
    // Hesap yokken açık boşluk; sonra ayrı tutarlar ayrı alanlarda görünür.
    expect(overview.json().account_budget).toBeNull();
    const { openDatabase } = await import("../src/storage/database.js");
    const live = await openDatabase({ dataDir: root });
    await new BudgetService(live).reconcileAccount(
      { userId: "local-owner", tenantId: "local" },
      1_234_000,
    );
    await live.close();
    const populated = await app.inject({
      url: `/api/overview?project_ref=${project.json().id}`,
      headers,
    });
    expect(populated.json().account_budget).toMatchObject({
      limit_micros: 1_234_000,
      reserved_micros: 0,
      spent_micros: 0,
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
