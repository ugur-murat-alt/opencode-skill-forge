import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { ForgeService } from "../src/application/forge.js";
import { SettingsService } from "../src/application/settings.js";
import { PackageStore } from "../src/skills/store.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";

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

/** Issue #9 + #26: the external HTTP consumer must apply the same operator
 * cap as the internal handler even when the tenant layer is looser. This
 * test issues a real HTTP request against a listening server. */
test("P2 #9/#26 external search over real HTTP applies the operator cap with a looser tenant policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-policy-http-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ searchMaxResults: 1 }),
    { mode: 0o600 },
  );
  const cfg = await localConfig(root);
  const app = await createHttpServer(cfg);
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Policy HTTP");
    // The tenant policy is deliberately looser; the operator cap still wins.
    await new SettingsService(identities, {}).update(owner, "policy", 0, {
      searchMaxResults: 20,
    });
    const store = new PackageStore(storage, root);
    for (const name of ["policy-ha", "policy-hb", "policy-hc"])
      await store.publish(owner, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: FILES(name),
      });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("server_address_missing");
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(
      `${base}/api/skills?project_ref=${encodeURIComponent(project.id)}` +
        `&query=${encodeURIComponent("shared search term")}&limit=20`,
      {
        headers: {
          host: new URL(cfg.url).host,
          authorization: `Bearer ${cfg.token}`,
        },
      },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { items: unknown[] };
    expect(payload.items).toHaveLength(1);
  } finally {
    await app.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
