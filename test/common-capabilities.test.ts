import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { SettingsService } from "../src/application/settings.js";
import { BudgetService } from "../src/jobs/budgets.js";
import { JobQueue } from "../src/jobs/queue.js";
import type { Settings } from "../src/domain/settings.js";
import type { JobKindDefinition } from "../src/domain/job-kinds.js";

/**
 * Issue #19 follow-up (#32): the common capabilities (identity, effective
 * policy, queue acceptance, audit wall, budget accounting) are exercised by a
 * registered model-free kind that never touches PackageStore, the SPR tools,
 * a skill provider or the evolution flag. This file only proves the
 * acceptance/budget/audit composition; the real claim -> handler -> result
 * chain of the same kind is covered by `test/job-kinds-contract.test.ts`.
 */
test("P2 #19/#32 common capabilities compose for a registered non-skill kind", async () => {
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

    // A non-skill kind is registered at construction; no provider profile,
    // skill package or evolution flag takes part in acceptance.
    const fixtureKind: JobKindDefinition = {
      kind: "capabilities_fixture",
      payload: z.object({ summary: z.string().min(1) }).strict(),
      skillProfile: false,
    };
    const queue = new JobQueue<"capabilities_fixture">(
      storage,
      { evolutionEnabled: false },
      { capabilities_fixture: fixtureKind },
    );
    const accepted = await queue.accept(owner, {
      projectId: project.id,
      kind: "capabilities_fixture",
      key: randomUUID(),
      payload: { summary: "Capability fixture" },
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.run.config_json).not.toContain("providerProfile");
    const attempts = await queue.attempts(owner, accepted.run.id);
    expect(attempts.status).toBe("queued");

    // The shared audit wall records the same acceptance event the skill kind
    // uses; this is not an observations/skill write.
    const acceptedEvents = await storage.db
      .selectFrom("audit_events")
      .select(["detail"])
      .where("tenant_id", "=", owner.tenantId)
      .where("kind", "=", "job.accepted")
      .execute();
    expect(
      acceptedEvents.some(
        (row) =>
          (JSON.parse(row.detail) as { run_id: string }).run_id ===
          accepted.run.id,
      ),
    ).toBe(true);

    // Budget accounts are shared infrastructure, independent of the kind.
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
    const runs = await storage.db
      .selectFrom("runs")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .execute();
    expect(runs).toHaveLength(1);
    // No skill package or provider profile exists anywhere in this flow.
    const skills = await storage.db
      .selectFrom("skills")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .execute();
    expect(skills).toHaveLength(0);
    const providers = await storage.db
      .selectFrom("provider_profiles")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .execute();
    expect(providers).toHaveLength(0);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
