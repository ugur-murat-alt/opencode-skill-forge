import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { SettingsService } from "../src/application/settings.js";
import { scoreSkill } from "../src/skills/scoring.js";

test("P20 scoring prefers names, coverage and usage deterministically", () => {
  const exact = scoreSkill("deploy helper", {
    name: "deploy-helper",
    description: "Misc.",
    updatedAt: 1,
    usage: 0,
  });
  const partial = scoreSkill("deploy helper", {
    name: "deploy-misc",
    description: "Helper tool.",
    updatedAt: 1,
    usage: 0,
  });
  const descOnly = scoreSkill("deploy helper", {
    name: "metrics",
    description: "Deploy helper output.",
    updatedAt: 1,
    usage: 0,
  });
  const boosted = scoreSkill("deploy helper", {
    name: "metrics",
    description: "Deploy helper output.",
    updatedAt: 1,
    usage: 9,
  });
  const empty = scoreSkill("", {
    name: "anything",
    description: "Whatever.",
    updatedAt: 1,
    usage: 0,
  });
  expect(exact.score).toBeGreaterThan(partial.score);
  expect(partial.score).toBeGreaterThan(descOnly.score);
  expect(boosted.score).toBeGreaterThan(descOnly.score);
  expect(boosted.score).toBeLessThanOrEqual(1);
  expect(empty.score).toBeGreaterThan(0);
  expect(exact.why.some((w) => w.startsWith("name"))).toBe(true);
  expect(boosted.why.some((w) => w.startsWith("usage"))).toBe(true);
  expect(
    scoreSkill("deploy", {
      name: "x",
      description: "y",
      updatedAt: 1,
      usage: 0,
    }).score,
  ).toBe(0);
  expect(
    scoreSkill("deploy", {
      name: "x",
      description: "y",
      updatedAt: 1,
      usage: 0,
    }).score,
  ).toBe(
    scoreSkill("deploy", {
      name: "x",
      description: "y",
      updatedAt: 1,
      usage: 0,
    }).score,
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forge-search-"));
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const project = await identities.createProject(owner, "Search");
  return { root, storage, identities, owner, project };
}

const FILES = (name: string, description: string) => ({
  "SKILL.md": Buffer.from(
    `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`,
  ),
});

async function publish(
  root: string,
  storage: Awaited<ReturnType<typeof openDatabase>>,
  owner: { tenantId: string; userId: string },
  projectId: string,
  name: string,
  description: string,
  scope: "project" | "personal" = "project",
) {
  return new PackageStore(storage, root).publish(owner, {
    name,
    scope,
    projectId,
    baseRevision: null,
    files: FILES(name, description),
  });
}

async function observe(
  storage: Awaited<ReturnType<typeof openDatabase>>,
  owner: { tenantId: string; userId: string },
  projectId: string,
  skillId: string,
  revision: string,
  times: number,
) {
  for (let i = 0; i < times; i++)
    await storage.db
      .insertInto("skill_observations")
      .values({
        tenant_id: owner.tenantId,
        id: randomUUID(),
        user_id: owner.userId,
        project_id: projectId,
        skill_id: skillId,
        revision,
        kind: "loaded",
        correlation: randomUUID(),
        created_at: Date.now(),
      })
      .execute();
}

test("P20 search ranks, explains, caps and pages with cursors", async () => {
  const { root, storage, owner, project } = await setup();
  try {
    const store = new PackageStore(storage, root);
    await publish(
      root,
      storage,
      owner,
      project.id,
      "deploy-helper",
      "Deploys apps.",
    );
    const metrics = await publish(
      root,
      storage,
      owner,
      project.id,
      "metrics",
      "Deploy logs and reports.",
    );
    await publish(root, storage, owner, project.id, "gardening", "Plant care.");
    await publish(
      root,
      storage,
      owner,
      project.id,
      "deploy-helper",
      "Personal copy.",
      "personal",
    );
    await observe(
      storage,
      owner,
      project.id,
      metrics.skill_id,
      metrics.revision,
      5,
    );
    const ranked = await store.search(owner, {
      projectId: project.id,
      query: "deploy",
      limit: 20,
    });
    const names = ranked.items.map((i) => i.name);
    expect(names[0]).toBe("deploy-helper");
    expect(names).toContain("metrics");
    expect(names).not.toContain("gardening");
    expect(ranked.items[0]!.score).toBeGreaterThan(ranked.items[1]!.score);
    expect(
      ranked.items
        .find((i) => i.name === "metrics")!
        .why.some((w) => w.startsWith("usage")),
    ).toBe(true);
    const copies = ranked.items.filter((i) => i.name === "deploy-helper");
    expect(copies).toHaveLength(1);
    expect(
      copies[0]!.other_scopes!.some((s) => s.startsWith("personal:")),
    ).toBe(true);
    const first = await store.search(owner, {
      projectId: project.id,
      query: "deploy",
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.next).toBeTruthy();
    const second = await store.search(owner, {
      projectId: project.id,
      query: "deploy",
      limit: 1,
      after: first.next!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.skill_id).not.toBe(first.items[0]!.skill_id);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P20 settings minScore and maxResults bound search", async () => {
  const { root, storage, identities, owner, project } = await setup();
  try {
    const store = new PackageStore(storage, root);
    await publish(
      root,
      storage,
      owner,
      project.id,
      "deploy-helper",
      "Deploys apps.",
    );
    await publish(root, storage, owner, project.id, "metrics", "Deploy logs.");
    const settings = new SettingsService(identities);
    await settings.update(owner, `project:${project.id}`, 0, {
      searchMinScore: 0.8,
    });
    const filtered = await store.search(owner, {
      projectId: project.id,
      query: "deploy",
      limit: 20,
    });
    expect(filtered.items.map((i) => i.name)).toEqual(["deploy-helper"]);
    await settings.update(owner, `project:${project.id}`, 1, {
      searchMinScore: 0,
      searchMaxResults: 1,
    });
    const capped = await store.search(owner, {
      projectId: project.id,
      query: "deploy",
      limit: 20,
    });
    expect(capped.items).toHaveLength(1);
    expect(capped.items[0]!.name).toBe("deploy-helper");
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P20 usage from other tenants never leaks across the wall", async () => {
  const { root, storage, identities, owner, project } = await setup();
  try {
    const orgs = new (
      await import("../src/application/organization.js")
    ).OrganizationService(storage.db);
    const second = await orgs.createOrganization(owner.userId, "Other");
    const other = { tenantId: second.id, userId: owner.userId };
    const store = new PackageStore(storage, root);
    const foreignProject = await identities.createProject(other, "Foreign");
    const foreign = await store.publish(other, {
      name: "deploy-helper",
      scope: "project",
      projectId: foreignProject.id,
      baseRevision: null,
      files: FILES("deploy-helper", "Deploys apps."),
    });
    await observe(
      storage,
      other,
      foreignProject.id,
      foreign.skill_id,
      foreign.revision,
      50,
    );
    const mine = await store.search(owner, {
      projectId: project.id,
      query: "deploy",
    });
    expect(mine.items.some((i) => i.skill_id === foreign.skill_id)).toBe(false);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P20 search rejects invalid cursors and hides archived duplicates", async () => {
  const { root, storage, owner, project } = await setup();
  try {
    const store = new PackageStore(storage, root);
    await publish(
      root,
      storage,
      owner,
      project.id,
      "deploy-helper",
      "Deploys apps.",
    );
    await publish(root, storage, owner, project.id, "metrics", "Deploy logs.");
    await expect(
      store.search(owner, {
        projectId: project.id,
        query: "deploy",
        after: "junk",
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      store.search(owner, {
        projectId: project.id,
        query: "deploy",
        after: "abc:def",
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    const withPersonal = await publish(
      root,
      storage,
      owner,
      project.id,
      "deploy-helper",
      "Personal copy.",
      "personal",
    );
    await storage.db
      .updateTable("skills")
      .set({ archived: 1 })
      .where("tenant_id", "=", owner.tenantId)
      .where("id", "=", withPersonal.skill_id)
      .execute();
    const ranked = await store.search(owner, {
      projectId: project.id,
      query: "deploy",
      limit: 20,
    });
    const copies = ranked.items.filter((i) => i.name === "deploy-helper");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.other_skill_ids ?? []).not.toContain(
      withPersonal.skill_id,
    );
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P20 searchMinScore merges with max and env wall covers export paths", async () => {
  const { root, storage, identities, owner, project } = await setup();
  try {
    const store = new PackageStore(storage, root);
    const settings = new SettingsService(identities);
    await settings.update(owner, "workspace", 0, { searchMinScore: 0.8 });
    await settings.update(owner, `project:${project.id}`, 0, {
      searchMinScore: 0.2,
    });
    const effective = await settings.effective(owner, project.id);
    expect(effective.values.searchMinScore).toBe(0.8);
    const { EnvironmentService } =
      await import("../src/application/environments.js");
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const pStaging = await identities.createProject(
      owner,
      "Staged",
      staging.id,
    );
    const published = await store.publish(owner, {
      name: "env-skill",
      scope: "environment",
      projectId: pStaging.id,
      baseRevision: null,
      files: FILES("env-skill", "Environment scoped fixture."),
    });
    const { MemberService } = await import("../src/application/members.js");
    const { PackageManager } = await import("../src/application/packages.js");
    const outsider = await new MemberService(storage.db).create(owner, {
      subject: `fixture|${randomUUID()}`,
      display_name: "Outsider",
      role: "writer",
    });
    const writer = { ...owner, userId: outsider.user_id };
    await new MemberService(storage.db).update(owner, outsider.user_id, {
      project_ref: project.id,
      generation: 0,
      project_generation: null,
      role: "writer",
      disabled: false,
      project_role: "writer",
    });
    const manager = new PackageManager(store);
    await expect(
      manager.export(writer, published.skill_id, published.revision),
    ).rejects.toMatchObject({ code: "skill_unavailable" });
    await expect(
      store.files(writer, published.skill_id, published.revision),
    ).rejects.toMatchObject({ code: "skill_unavailable" });
    await expect(
      store.authorizedSkill(writer, published.skill_id),
    ).rejects.toMatchObject({ code: "skill_unavailable" });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
