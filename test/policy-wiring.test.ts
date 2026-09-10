import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { ForgeService } from "../src/application/forge.js";
import { SettingsService } from "../src/application/settings.js";

const FILES = (name: string) => ({
  "SKILL.md": Buffer.from(
    `---\nname: ${name}\ndescription: Policy wiring fixture with a shared search term.\n---\nBody.\n`,
  ),
});

/** Issue #9: ForgeService must hand the operator policy to PackageStore so
 * effective settings and the real forge_search cap agree. */
test("P2 #9 operator searchMaxResults reaches real search results", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-policy-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Policy");
    const policy = { searchMaxResults: 1 };
    const forge = new ForgeService(storage, root, "wiring-key", policy);
    for (const name of ["policy-a", "policy-b", "policy-c"])
      await forge.packages.publish(owner, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: FILES(name),
      });
    const settings = new SettingsService(
      new IdentityService(storage.db),
      policy,
    );
    const effective = await settings.effective(owner, project.id);
    expect(effective.values.searchMaxResults).toBe(1);
    const found = await forge.packages.search(owner, {
      projectId: project.id,
      query: "shared search term",
      limit: 20,
    });
    expect(found.items).toHaveLength(1);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Same wiring through the HTTP consumer path (forge.invoke → search). */
test("P2 #9 HTTP search consumer respects the operator policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-policy-http-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Policy HTTP");
    const forge = new ForgeService(storage, root, "wiring-key", {
      searchMaxResults: 1,
    });
    for (const name of ["policy-ha", "policy-hb"])
      await forge.packages.publish(owner, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: FILES(name),
      });
    const invoked = await forge.invoke("forge_search", owner, {
      project_ref: project.id,
      query: "shared search term",
      limit: 20,
    } as never);
    const payload = invoked as { items: unknown[] };
    expect(payload.items).toHaveLength(1);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
