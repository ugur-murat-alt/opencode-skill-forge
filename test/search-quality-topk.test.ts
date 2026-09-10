import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore, searchText } from "../src/skills/store.js";

interface SeedEntry {
  id: string;
  name: string;
  description: string;
  updateOffset: number;
}

const revisionFor = (id: string) =>
  createHash("sha256").update(id).digest("hex");
const idAt = (sequence: number) =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

/** Deterministic bulk fixture. Rows mirror what PackageStore.publish writes
 * (search_text, active revision pointer, revision row) but skip the filesystem
 * so the 1000+ candidate acceptance stays fast. */
async function seedSkills(
  storage: Awaited<ReturnType<typeof openDatabase>>,
  owner: { tenantId: string; userId: string },
  projectId: string,
  entries: SeedEntry[],
) {
  const now = Date.now();
  for (let offset = 0; offset < entries.length; offset += 200) {
    const chunk = entries.slice(offset, offset + 200);
    await storage.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("skills")
        .values(
          chunk.map((entry) => ({
            tenant_id: owner.tenantId,
            id: entry.id,
            scope_key: `project:${projectId}`,
            project_id: projectId,
            owner_id: owner.userId,
            name: entry.name,
            description: entry.description,
            search_text: searchText(`${entry.name} ${entry.description}`),
            active_revision: null,
            managed: 1,
            pinned: 0,
            protected: 0,
            archived: 0,
            created_at: now,
            updated_at: now + entry.updateOffset,
          })),
        )
        .execute();
      await tx
        .insertInto("skill_revisions")
        .values(
          chunk.map((entry) => ({
            tenant_id: owner.tenantId,
            skill_id: entry.id,
            revision: revisionFor(entry.id),
            manifest_json: JSON.stringify({ files: [] }),
            package_path: `test/${entry.id}`,
            created_by: owner.userId,
            run_id: null,
            validation_json: JSON.stringify({ passed: true }),
            created_at: now,
          })),
        )
        .execute();
      for (const entry of chunk)
        await tx
          .updateTable("skills")
          .set({ active_revision: revisionFor(entry.id) })
          .where("tenant_id", "=", owner.tenantId)
          .where("id", "=", entry.id)
          .execute();
    });
  }
}

/** Issue #24 acceptance: the target has the strongest name match but also the
 * largest candidate id, so the old "first 100 ids, then rank" batch never put
 * it on the first page. */
function catalog(total: number, targetName: string): SeedEntry[] {
  const entries: SeedEntry[] = [];
  for (let i = 0; i < total - 1; i++)
    entries.push({
      id: idAt(i),
      name: `rank-filler-${String(i).padStart(4, "0")}`,
      description: `Rank probe fixture ${i}.`,
      updateOffset: i,
    });
  entries.push({
    id: idAt(total),
    name: targetName,
    description: "Rank probe fixture target.",
    updateOffset: total,
  });
  return entries;
}

async function flatTraversal(
  store: PackageStore,
  owner: { tenantId: string; userId: string },
  projectId: string,
  query: string,
  limit: number,
) {
  const flat: { skill_id: string; name: string; score: number }[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 200; pages++) {
    const page = await store.search(owner, {
      projectId,
      query,
      limit,
      ...(after ? { after } : {}),
    });
    flat.push(
      ...page.items.map((item) => ({
        skill_id: item.skill_id,
        name: item.name,
        score: item.score,
      })),
    );
    if (!page.next) return flat;
    after = page.next;
  }
  throw new Error("pagination did not terminate");
}

test("P2 #24 high-relevance target in the last id group is in the defined top-k (150)", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-topk-150-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "TopK150");
    const store = new PackageStore(storage, root);
    const entries = catalog(150, "probe-rank-target");
    await seedSkills(storage, owner, project.id, entries);
    const target = entries.at(-1)!;
    const first = await store.search(owner, {
      projectId: project.id,
      query: "rank probe",
      limit: 5,
    });
    expect(first.items[0]!.skill_id).toBe(target.id);
    expect(first.items.map((item) => item.score)).toEqual(
      first.items.map((item) => item.score).sort((a, b) => b - a),
    );
    const flat = await flatTraversal(
      store,
      owner,
      project.id,
      "rank probe",
      20,
    );
    expect(flat).toHaveLength(150);
    expect(new Set(flat.map((row) => row.skill_id)).size).toBe(150);
    expect(new Set(flat.map((row) => row.name)).size).toBe(150);
    expect(flat.filter((row) => row.skill_id === target.id)).toHaveLength(1);
    // Scores are globally non-increasing across page boundaries.
    for (let i = 1; i < flat.length; i++)
      expect(flat[i]!.score).toBeLessThanOrEqual(flat[i - 1]!.score);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("P2 #24 high-relevance target in the last id group is in the defined top-k (1001)", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-topk-1001-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "TopK1001");
    const store = new PackageStore(storage, root);
    const entries = catalog(1001, "probe-rank-target");
    await seedSkills(storage, owner, project.id, entries);
    const target = entries.at(-1)!;
    const first = await store.search(owner, {
      projectId: project.id,
      query: "rank probe",
      limit: 5,
    });
    expect(first.items[0]!.skill_id).toBe(target.id);
    const flat = await flatTraversal(
      store,
      owner,
      project.id,
      "rank probe",
      20,
    );
    expect(flat).toHaveLength(1001);
    expect(new Set(flat.map((row) => row.skill_id)).size).toBe(1001);
    expect(new Set(flat.map((row) => row.name)).size).toBe(1001);
    expect(flat.filter((row) => row.skill_id === target.id)).toHaveLength(1);
    for (let i = 1; i < flat.length; i++)
      expect(flat[i]!.score).toBeLessThanOrEqual(flat[i - 1]!.score);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
