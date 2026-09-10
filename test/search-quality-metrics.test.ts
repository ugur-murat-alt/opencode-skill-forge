import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { ForgeService } from "../src/application/forge.js";
import { PackageStore } from "../src/skills/store.js";

const FILES = (name: string, description: string) => ({
  "SKILL.md": Buffer.from(
    `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`,
  ),
});

/** Issue #24 acceptance: scanned rows, query count, latency and the agent
 * token cost of the payload must reach the public forge_search wrapper, which
 * previously dropped the store's `scanned` diagnostic entirely. */
test("P2 #24 forge_search carries scan/query/latency/token diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-metrics-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Metrics");
    const forge = new ForgeService(storage, root, "metrics-key");
    const store = new PackageStore(storage, root);
    for (let i = 0; i < 3; i++)
      await store.publish(owner, {
        name: `metrics-probe-${"abc"[i]}`,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: FILES(`metrics-probe-${"abc"[i]}`, "Metrics probe fixture."),
      });
    const result = (await forge.invoke("forge_search", owner, {
      project_ref: project.id,
      query: "metrics probe",
      limit: 5,
    })) as Record<string, unknown>;
    expect(result.items).toBeArray();
    expect((result.items as unknown[]).length).toBe(3);
    expect(Number.isInteger(result.scanned)).toBe(true);
    expect(result.scanned as number).toBeGreaterThan(0);
    expect(Number.isInteger(result.scored)).toBe(true);
    expect(result.scored as number).toBeGreaterThan(0);
    expect(result.scanned as number).toBeGreaterThanOrEqual(
      result.scored as number,
    );
    expect(Number.isInteger(result.queries)).toBe(true);
    expect(result.queries as number).toBeGreaterThanOrEqual(1);
    expect(typeof result.latency_ms).toBe("number");
    expect(result.latency_ms as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.result_bytes)).toBe(true);
    expect(result.result_bytes as number).toBeGreaterThan(0);
    expect(Number.isInteger(result.token_estimate)).toBe(true);
    expect(result.token_estimate as number).toBeGreaterThan(0);
    expect(result.next_cursor).toBeNull();
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
