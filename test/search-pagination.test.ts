import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";

const TOTAL = 150;
const TERMED = 120;

function files(index: number, named: boolean) {
  const name = named
    ? `deploy-target-${String(index).padStart(3, "0")}`
    : `catalog-${String(index).padStart(3, "0")}`;
  return {
    "SKILL.md": Buffer.from(
      `---\nname: ${name}\ndescription: Pagination fixture ${index} for the catalog.\n---\nBody.\n`,
    ),
  };
}

/** Issue #6: catalog listing and term search must reach the whole authorized
 * set through keyset paging instead of stopping at the first 100 candidates. */
test("P2 #6 search traversal reaches every package beyond the first 100", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-page-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Catalog");
    const store = new PackageStore(storage, root);
    for (let i = 1; i <= TOTAL; i++)
      await store.publish(owner, {
        name:
          i <= TERMED
            ? `deploy-target-${String(i).padStart(3, "0")}`
            : `catalog-${String(i).padStart(3, "0")}`,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: files(i, i <= TERMED),
      });
    const collect = async (query: string | undefined) => {
      const seen = new Map<string, string>();
      let after: string | null | undefined;
      for (let pages = 0; pages < 400; pages++) {
        const result = await store.search(owner, {
          projectId: project.id,
          query,
          ...(after ? { after: after! } : {}),
        });
        for (const item of result.items) seen.set(item.skill_id, item.name);
        if (!result.next) return { seen, pages: pages + 1 };
        after = result.next;
      }
      throw new Error("pagination did not terminate");
    };
    const catalog = await collect(undefined);
    expect(catalog.seen.size).toBe(TOTAL);
    // Kararlı keyset: kayıt kaybı ya da tekrarı yok.
    expect(catalog.seen.size).toBe(new Set(catalog.seen.keys()).size);
    const term = await collect("deploy");
    expect(term.seen.size).toBe(TERMED);
    expect(
      [...term.seen.values()].every((n) => n.startsWith("deploy-target-")),
    ).toBe(true);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
