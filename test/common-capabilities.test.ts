import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { SettingsService } from "../src/application/settings.js";
import { BudgetService } from "../src/jobs/budgets.js";
import { JobQueue } from "../src/jobs/queue.js";
import type { Settings } from "../src/domain/settings.js";

/**
 * Issue #19 pilot: common capabilities (identity, effective policy, job
 * queue, budget accounting, audit/observations) compose into a non-skill
 * flow WITHOUT touching PackageStore or the skill evolution runner. Test
 * fixture only — no new production feature.
 */
test("P2 #19 common capabilities compose without the skill module", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-capabilities-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Capabilities");

    // Effective policy resolution needs no skill module.
    const policy: Settings = { searchMinScore: 0.5, allowPaid: true };
    const settings = new SettingsService(
      new IdentityService(storage.db),
      policy,
    );
    const effective = await settings.effective(owner, project.id);
    expect(effective.values.allowPaid).toBe(true);
    expect(effective.sources.searchMinScore).toBe("operator_policy");

    // The queue accepts, budgets reserve/settle and audit records — none of
    // these depend on the skill store.
    const queue = new JobQueue(storage);
    const accepted = await queue.accept(owner, {
      projectId: project.id,
      kind: "skill_evolve",
      key: randomUUID(),
      payload: { summary: "Capability fixture" },
    });
    expect(accepted.status).toBe("accepted");
    const budget = new BudgetService(storage);
    await budget.reconcileAccount(owner, 500_000);
    const reservation = randomUUID();
    await budget.reserve(owner, accepted.run.id, reservation, 100_000);
    await budget.settle(owner, reservation, 40_000);
    const account = await storage.db
      .selectFrom("budget_accounts")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .where("user_id", "=", owner.userId)
      .executeTakeFirstOrThrow();
    expect(account.spent_micros).toBe(40_000);
    // Observability writes ride the shared observation wall.
    // The queue's acceptance state and fairness row are shared infra.
    const runs = await storage.db
      .selectFrom("runs")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .execute();
    expect(runs).toHaveLength(1);
    // No skill package exists anywhere in this flow.
    const skills = await storage.db
      .selectFrom("skills")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .execute();
    expect(skills).toHaveLength(0);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
