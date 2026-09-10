import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { EnvironmentService } from "../src/application/environments.js";
import { PackageStore, searchText } from "../src/skills/store.js";

interface SeedEntry {
  id: string;
  name: string;
  description: string;
  scopeKey: string;
  projectId: string | null;
}

const revisionFor = (id: string) =>
  createHash("sha256").update(id).digest("hex");
const idAt = (sequence: number) =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

async function seedSkills(
  storage: Awaited<ReturnType<typeof openDatabase>>,
  owner: { tenantId: string; userId: string },
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
            scope_key: entry.scopeKey,
            project_id: entry.projectId,
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
            updated_at: now,
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

/** Issue #24 acceptance: the same name in workspace/environment/project/
 * personal must merge into one result with priority-ordered scope metadata even
 * when the records are spread across the old 100-row candidate boundary. */
test("P2 #24 same-name packages beyond the batch boundary merge with scope priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-merge-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const environment = await new EnvironmentService(storage.db).create(owner, {
      name: "staging",
    });
    const project = await identities.createProject(
      owner,
      "Merge",
      environment.id,
    );
    const store = new PackageStore(storage, root);
    const workspaceScope = "workspace";
    const personalScope = `personal:${owner.userId}`;
    const projectScope = `project:${project.id}`;
    const environmentScope = `environment:${environment.id}`;
    let sequence = 0;
    const fillers = (count: number) =>
      Array.from({ length: count }, () => {
        const i = sequence++;
        return {
          id: idAt(i),
          name: `merge-filler-${String(i).padStart(4, "0")}`,
          description: `Scope merge probe filler ${i}.`,
          scopeKey: projectScope,
          projectId: project.id,
        } satisfies SeedEntry;
      });
    const copy = (scopeKey: string, projectId: string | null): SeedEntry => ({
      id: idAt(sequence++),
      name: "scope-merge-probe",
      description: "Scope merge probe copy.",
      scopeKey,
      projectId,
    });
    const entries: SeedEntry[] = [
      ...fillers(99),
      copy(workspaceScope, null), // id 99: last row of the old first batch
      copy(personalScope, null), // id 100: first row of the old second batch
      ...fillers(100),
      copy(projectScope, project.id), // id 201: far beyond the old first batch
      copy(environmentScope, null), // id 202
    ];
    await seedSkills(storage, owner, entries);
    const workspaceId = idAt(99);
    const personalId = idAt(100);
    const projectId = idAt(201);
    const environmentId = idAt(202);
    const first = await store.search(owner, {
      projectId: project.id,
      query: "scope merge probe",
      limit: 5,
    });
    const merged = first.items.filter(
      (item) => item.name === "scope-merge-probe",
    );
    expect(merged).toHaveLength(1);
    // Project scope has the highest priority even though its record sorts last.
    expect(merged[0]!.skill_id).toBe(projectId);
    expect(merged[0]!.scope).toBe(projectScope);
    expect(merged[0]!.other_scopes).toEqual([
      environmentScope,
      workspaceScope,
      personalScope,
    ]);
    expect(merged[0]!.other_skill_ids).toEqual([
      environmentId,
      workspaceId,
      personalId,
    ]);
    expect(new Set(merged[0]!.other_skill_ids).size).toBe(3);
    // Flat traversal sees the merged name exactly once and every filler once.
    const flat: { skill_id: string; name: string }[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 200; pages++) {
      const page = await store.search(owner, {
        projectId: project.id,
        query: "scope merge probe",
        limit: 20,
        ...(after ? { after } : {}),
      });
      flat.push(
        ...page.items.map((item) => ({
          skill_id: item.skill_id,
          name: item.name,
        })),
      );
      if (!page.next) break;
      after = page.next;
    }
    expect(flat).toHaveLength(entries.length - 3);
    expect(new Set(flat.map((row) => row.skill_id)).size).toBe(
      entries.length - 3,
    );
    expect(new Set(flat.map((row) => row.name)).size).toBe(entries.length - 3);
    expect(flat.filter((row) => row.name === "scope-merge-probe")).toHaveLength(
      1,
    );
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
