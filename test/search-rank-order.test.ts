import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";

const FILES = (name: string, description: string) => ({
  "SKILL.md": Buffer.from(
    `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`,
  ),
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forge-rank-"));
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const project = await identities.createProject(owner, "Rank");
  const store = new PackageStore(storage, root);
  return { root, storage, owner, project, store };
}

async function search(
  store: PackageStore,
  owner: { tenantId: string; userId: string },
  projectId: string,
  query: string,
  after?: string,
) {
  return store.search(owner, {
    projectId,
    query,
    limit: 20,
    ...(after ? { after } : {}),
  });
}

/** Issue #24: the search order is defined and tested: score desc, scope
 * priority desc, updated_at desc, id asc. */
test("P2 #24 search order is score, scope priority, recency and id", async () => {
  const { root, storage, owner, project, store } = await setup();
  try {
    await store.publish(owner, {
      name: "order-probe",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: FILES("order-probe", "Exact match."),
    });
    await store.publish(owner, {
      name: "order-misc",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: FILES("order-misc", "Probe helper."),
    });
    await store.publish(owner, {
      name: "alpha-doc",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: FILES("alpha-doc", "Order probe docs."),
    });
    await store.publish(owner, {
      name: "gamma-doc",
      scope: "workspace",
      baseRevision: null,
      files: FILES("gamma-doc", "Order probe docs."),
    });
    await store.publish(owner, {
      name: "beta-doc",
      scope: "personal",
      baseRevision: null,
      files: FILES("beta-doc", "Order probe docs."),
    });
    const result = await search(store, owner, project.id, "order probe");
    expect(result.items.map((item) => item.name)).toEqual([
      "order-probe",
      "order-misc",
      "alpha-doc",
      "gamma-doc",
      "beta-doc",
    ]);
    const scores = result.items.map((item) => item.score);
    for (let i = 1; i < scores.length; i++)
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Issue #6 gain kept: a legacy `scan:` cursor still resumes the candidate
 * universe after the given candidate id. */
test("P2 #24 legacy scan cursor resumes after the anchored candidate id", async () => {
  const { root, storage, owner, project, store } = await setup();
  try {
    const first = await store.publish(owner, {
      name: "scan-probe-one",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: FILES("scan-probe-one", "Scan cursor fixture."),
    });
    const second = await store.publish(owner, {
      name: "scan-probe-two",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: FILES("scan-probe-two", "Scan cursor fixture."),
    });
    const [anchor, beyond] = [first.skill_id, second.skill_id].sort();
    const resumed = await search(
      store,
      owner,
      project.id,
      "scan cursor",
      `scan:${anchor}`,
    );
    expect(resumed.items.some((item) => item.skill_id === anchor)).toBe(false);
    expect(resumed.items.some((item) => item.skill_id === beyond)).toBe(true);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #24 malformed cursors stay rejected after the rank cursor change", async () => {
  const { root, storage, owner, project, store } = await setup();
  try {
    await store.publish(owner, {
      name: "cursor-probe",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: FILES("cursor-probe", "Cursor fixture."),
    });
    for (const after of [
      "junk",
      "abc:def",
      "r1:",
      "r1:1.5:4:1:id",
      "r1:0.5:x:1:id",
      "r1:0.5:4:-1:id",
      "r1:0.5:4:1:",
    ])
      await expect(
        store.search(owner, { projectId: project.id, query: "cursor", after }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Issue #24: concurrent mutation semantics are documented as best-effort.
 * Removing a not-yet-returned package between pages must still terminate the
 * traversal and must not duplicate already returned items. */
test("P2 #24 cursor traversal survives a concurrent archive without duplicates", async () => {
  const { root, storage, owner, project, store } = await setup();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const published = await store.publish(owner, {
        name: `mutate-probe-${String(i).padStart(3, "0")}`,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: FILES(
          `mutate-probe-${String(i).padStart(3, "0")}`,
          "Concurrent cursor fixture.",
        ),
      });
      ids.push(published.skill_id);
    }
    const seen: string[] = [];
    let after: string | undefined;
    let archived = false;
    for (let pages = 0; pages < 60; pages++) {
      const page = await store.search(owner, {
        projectId: project.id,
        query: "concurrent cursor",
        limit: 5,
        ...(after ? { after } : {}),
      });
      seen.push(...page.items.map((item) => item.skill_id));
      if (!archived && page.items.length) {
        const returned = new Set(seen);
        const victim = ids.find((id) => !returned.has(id))!;
        await storage.db
          .updateTable("skills")
          .set({ archived: 1 })
          .where("tenant_id", "=", owner.tenantId)
          .where("id", "=", victim)
          .execute();
        archived = true;
      }
      if (!page.next) break;
      after = page.next;
    }
    expect(archived).toBe(true);
    expect(seen).toHaveLength(39);
    expect(new Set(seen).size).toBe(39);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
