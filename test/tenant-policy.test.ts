import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { SettingsService } from "../src/application/settings.js";
import { JobQueue } from "../src/jobs/queue.js";
test("tenant policy: admin setup, operator ceilings, source labels and immutable accepted snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-policy-")),
    storage = await openDatabase({ dataDir: root });
  try {
    const identity = new IdentityService(storage.db),
      owner = await identity.bootstrapLocal(),
      project = await identity.createProject(owner, "Policy contract"),
      settings = new SettingsService(identity);
    await settings.update(owner, "policy", 0, {
      allowPaid: true,
      allowedOrigins: ["https://api.openai.com"],
      maxCostMicros: 1000000,
      maxTokens: 32000,
      dependencyInstall: true,
    });
    const effective = await settings.effective(owner, project.id);
    expect(effective.values.allowPaid).toBe(true);
    expect(effective.sources.allowPaid).toBe("tenant_policy");
    const limited = await new SettingsService(identity, {
      allowPaid: false,
      maxCostMicros: 0,
      maxTokens: 1000,
      allowedOrigins: [],
      dependencyInstall: false,
    }).effective(owner, project.id);
    expect(limited.values.allowPaid).toBe(false);
    expect(limited.values.maxTokens).toBe(1000);
    expect(limited.values.allowedOrigins).toEqual([]);
    expect(limited.sources.allowPaid).toBe("operator_policy");
    expect(limited.values.dependencyInstall).toBe(false);
    const accepted = await new JobQueue(storage).accept(owner, {
      projectId: project.id,
      kind: "prompt_edit",
      key: "snapshot",
      payload: { original: "Preserve 3 units." },
    });
    await settings.update(owner, "policy", 1, { allowPaid: false });
    const unchanged = await new JobQueue(storage).get(owner, accepted.run.id);
    expect(JSON.parse(unchanged.config_json).values.allowPaid).toBe(true);
    await storage.db
      .insertInto("users")
      .values({
        id: "viewer",
        subject: "viewer",
        display_name: "Viewer",
        created_at: Date.now(),
      })
      .execute();
    await storage.db
      .insertInto("memberships")
      .values({ tenant_id: owner.tenantId, user_id: "viewer", role: "viewer" })
      .execute();
    await expect(
      settings.update(
        { tenantId: owner.tenantId, userId: "viewer" },
        "policy",
        2,
        { allowPaid: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
