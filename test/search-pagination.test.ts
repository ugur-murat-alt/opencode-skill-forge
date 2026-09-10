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

/** Issue #6/#24: catalog listing and term search must reach the whole
 * authorized set through keyset paging instead of stopping at the first 100
 * candidates. Issue #24: results are collected into flat arrays first, so the
 * duplicate/skip checks see every returned row instead of a Map that hides
 * repeated ids by construction. */
test("P2 #6/#24 search traversal reaches every package beyond the first 100 without repeats", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-page-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Catalog");
    const store = new PackageStore(storage, root);
    const expectedCatalog = new Set<string>();
    const expectedTermed = new Set<string>();
    for (let i = 1; i <= TOTAL; i++) {
      const published = await store.publish(owner, {
        name:
          i <= TERMED
            ? `deploy-target-${String(i).padStart(3, "0")}`
            : `catalog-${String(i).padStart(3, "0")}`,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: files(i, i <= TERMED),
      });
      expectedCatalog.add(published.skill_id);
      if (i <= TERMED) expectedTermed.add(published.skill_id);
    }
    const collect = async (query: string | undefined) => {
      const flat: { skill_id: string; name: string }[] = [];
      let after: string | null | undefined;
      for (let pages = 0; pages < 400; pages++) {
        const result = await store.search(owner, {
          projectId: project.id,
          query,
          ...(after ? { after: after! } : {}),
        });
        flat.push(
          ...result.items.map((item) => ({
            skill_id: item.skill_id,
            name: item.name,
          })),
        );
        if (!result.next) return { flat, pages: pages + 1 };
        after = result.next;
      }
      throw new Error("pagination did not terminate");
    };
    const catalog = await collect(undefined);
    // Flat arrays expose real duplicates and skips instead of a Map key set.
    expect(catalog.flat).toHaveLength(TOTAL);
    expect(new Set(catalog.flat.map((row) => row.skill_id)).size).toBe(TOTAL);
    expect(new Set(catalog.flat.map((row) => row.name)).size).toBe(TOTAL);
    expect(new Set(catalog.flat.map((row) => row.skill_id))).toEqual(
      expectedCatalog,
    );
    const term = await collect("deploy");
    expect(term.flat).toHaveLength(TERMED);
    expect(new Set(term.flat.map((row) => row.skill_id)).size).toBe(TERMED);
    expect(new Set(term.flat.map((row) => row.skill_id))).toEqual(
      expectedTermed,
    );
    expect(
      term.flat.every((row) => row.name.startsWith("deploy-target-")),
    ).toBe(true);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
