import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { EnvironmentService } from "../src/application/environments.js";
import { PackageStore } from "../src/skills/store.js";
import { SettingsService } from "../src/application/settings.js";
import { MemberService } from "../src/application/members.js";
import { BindingService } from "../src/application/bindings.js";

const FILES = {
  "SKILL.md": Buffer.from(
    "---\nname: env-skill\ndescription: Environment scoped fixture.\n---\nBody.\n",
  ),
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forge-env-"));
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  return { root, storage, identities, owner };
}

test("P19 environments scope projects with a protected default", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const envs = new EnvironmentService(storage.db);
    const initial = await envs.list(owner);
    expect(initial).toHaveLength(1);
    expect(initial[0]!.name).toBe("default");
    const staging = await envs.create(owner, { name: "staging" });
    expect((await envs.list(owner)).map((e) => e.name).sort()).toEqual([
      "default",
      "staging",
    ]);
    const pDefault = await identities.createProject(owner, "In default");
    const pStaging = await identities.createProject(
      owner,
      "In staging",
      staging.id,
    );
    const resolved = await envs.resolveProject(owner.tenantId, pStaging.id);
    expect(resolved.environment_id).toBe(staging.id);
    const resolvedDefault = await envs.resolveProject(
      owner.tenantId,
      pDefault.id,
    );
    expect(resolvedDefault.environment_id).toBe(initial[0]!.id);
    await expect(envs.remove(owner, initial[0]!.id)).rejects.toMatchObject({
      code: "env_protected",
    });
    await expect(envs.remove(owner, staging.id)).rejects.toMatchObject({
      code: "env_in_use",
    });
    await expect(
      envs.resolveProject("foreign-tenant", pDefault.id),
    ).rejects.toMatchObject({ code: "project_unavailable" });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P19 environment skills are visible only inside their environment", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const pDefault = await identities.createProject(owner, "App");
    const pStaging = await identities.createProject(
      owner,
      "Staging app",
      staging.id,
    );
    const store = new PackageStore(storage, root);
    await store.publish(owner, {
      name: "env-skill",
      scope: "environment",
      projectId: pStaging.id,
      baseRevision: null,
      files: FILES,
    });
    const seen = await store.search(owner, {
      projectId: pStaging.id,
      query: "env-skill",
    });
    expect(seen.items.map((i) => i.name)).toContain("env-skill");
    const hidden = await store.search(owner, {
      projectId: pDefault.id,
      query: "env-skill",
    });
    expect(hidden.items.map((i) => i.name)).not.toContain("env-skill");
    const skillId = seen.items.find((i) => i.name === "env-skill")!.skill_id;
    const revision = seen.items.find((i) => i.name === "env-skill")!.revision;
    await expect(
      store.files({ ...owner, userId: owner.userId }, skillId, revision!),
    ).resolves.toBeDefined();
    const outsider = await new MemberService(storage.db).create(owner, {
      subject: `fixture|${randomUUID()}`,
      display_name: "Outsider",
      role: "writer",
    });
    const outsiderIdentity = { ...owner, userId: outsider.user_id };
    await new MemberService(storage.db).update(owner, outsider.user_id, {
      project_ref: pDefault.id,
      generation: 0,
      project_generation: null,
      role: "writer",
      disabled: false,
      project_role: "writer",
    });
    await expect(
      store.files(outsiderIdentity, skillId, revision!),
    ).rejects.toMatchObject({ code: "skill_unavailable" });
    const explicit = await store.search(owner, {
      projectId: pDefault.id,
      query: "",
      scope: "environment",
    });
    expect(explicit.items.map((i) => i.name)).not.toContain("env-skill");
    await expect(
      store.publish(
        { ...owner, userId: "stranger" },
        {
          name: "env-skill",
          scope: "environment",
          projectId: pStaging.id,
          baseRevision: null,
          files: FILES,
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P19 skill scope moves are explicit, CAS-guarded and authorized", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const project = await identities.createProject(owner, "Movable");
    const store = new PackageStore(storage, root);
    const first = await store.publish(owner, {
      name: "env-skill",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: FILES,
    });
    const moved = await store.setScope(owner, first.skill_id, {
      scope: "environment",
      projectId: project.id,
      expectedRevision: first.revision,
    });
    expect(moved.scope_key).toBe(
      `environment:${await resolvedEnv(storage, project.id)}`,
    );
    await expect(
      store.setScope(owner, first.skill_id, {
        scope: "project",
        projectId: project.id,
        expectedRevision: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const writer = await (async () => {
      const created = await new MemberService(storage.db).create(owner, {
        subject: `fixture|${randomUUID()}`,
        display_name: "Writer",
        role: "writer",
      });
      return { ...owner, userId: created.user_id };
    })();
    await expect(
      store.setScope(writer, first.skill_id, {
        scope: "workspace",
        expectedRevision: moved.active_revision,
      }),
    ).rejects.toMatchObject({ status: 403 });
    void staging;
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }

  async function resolvedEnv(storage: any, projectId: string) {
    const row = await storage.db
      .selectFrom("projects")
      .select("environment_id")
      .where("id", "=", projectId)
      .executeTakeFirstOrThrow();
    return row.environment_id;
  }
});

test("P19 environment removal refuses referenced scopes", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const project = await identities.createProject(owner, "Scoped", staging.id);
    const store = new PackageStore(storage, root);
    await store.publish(owner, {
      name: "env-skill",
      scope: "environment",
      projectId: project.id,
      baseRevision: null,
      files: {
        "SKILL.md": Buffer.from(
          "---\nname: env-skill\ndescription: Scoped.\n---\nBody.\n",
        ),
      },
    });
    const settings = new SettingsService(identities);
    await settings.update(owner, `environment:${staging.id}`, 0, {
      retentionDays: 9,
    });
    await expect(envs.remove(owner, staging.id)).rejects.toMatchObject({
      code: "env_in_use",
    });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P19 environment settings layer sits between workspace and project", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const project = await identities.createProject(
      owner,
      "Layered",
      staging.id,
    );
    const settings = new SettingsService(identities);
    await settings.update(owner, "workspace", 0, { retentionDays: 30 });
    await settings.update(owner, `environment:${staging.id}`, 0, {
      retentionDays: 7,
    });
    const effective = await settings.effective(owner, project.id);
    expect(effective.values.retentionDays).toBe(7);
    expect(effective.sources.retentionDays).toBe(`environment:${staging.id}`);
    await settings.update(owner, `project:${project.id}`, 0, {
      retentionDays: 3,
    });
    expect(
      (await settings.effective(owner, project.id)).values.retentionDays,
    ).toBe(3);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P19 bindings record local identity and detect moved directories", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const project = await identities.createProject(owner, "Bound");
    const local = join(root, "local-proj");
    await mkdir(local, { recursive: true });
    const bindings = new BindingService(storage.db);
    const bound = await bindings.bind(
      { ...owner, userId: owner.userId },
      {
        project_id: project.id,
        client_id: "codex",
        path: local,
        local_name: "local-proj",
      },
    );
    expect(bound.project_id).toBe(project.id);
    expect(bound.local_name).toBe("local-proj");
    const ok = await bindings.verify(owner, {
      client_id: "codex",
      path: local,
    });
    expect(ok.status).toBe("bound");
    const moved = `${local}-moved`;
    await rename(local, moved);
    const stale = await bindings.verify(owner, {
      client_id: "codex",
      path: local,
    });
    expect(stale.status).toBe("stale");
    void moved;
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P19 028 migration dedups duplicate environment names and heals orphans", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const { environmentUniquenessMigration } =
      await import("../src/storage/environment-uniqueness-migration.js");
    const before = await new EnvironmentService(storage.db).list(owner);
    const kept = before.find((e) => e.name === "default")!;
    const orphan = await identities.createProject(owner, "Orphaned");
    const lost = await identities.createProject(owner, "Lost");
    await storage.db.schema.dropIndex("environment_name_unique").execute();
    const { randomUUID: uuid } = await import("node:crypto");
    const dupId = uuid();
    await storage.db
      .insertInto("environments")
      .values({
        tenant_id: owner.tenantId,
        id: dupId,
        name: "default",
        created_at: Date.now() + 1000,
      })
      .execute();
    await storage.db
      .updateTable("projects")
      .set({ environment_id: dupId })
      .where("tenant_id", "=", owner.tenantId)
      .where("id", "=", orphan.id)
      .execute();
    await storage.db
      .updateTable("projects")
      .set({ environment_id: "missing-env" })
      .where("tenant_id", "=", owner.tenantId)
      .where("id", "=", lost.id)
      .execute();
    await environmentUniquenessMigration.up(storage.db);
    const after = await new EnvironmentService(storage.db).list(owner);
    expect(after.filter((e) => e.name === "default")).toHaveLength(1);
    expect(after.find((e) => e.name === "default")!.id).toBe(kept.id);
    const fixed = await storage.db
      .selectFrom("projects")
      .select(["id", "environment_id"])
      .where("tenant_id", "=", owner.tenantId)
      .execute();
    for (const p of fixed)
      expect(
        after.some((e) => e.id === p.environment_id),
        `project ${p.id} points at a live environment`,
      ).toBe(true);
    await expect(
      storage.db
        .insertInto("environments")
        .values({
          tenant_id: owner.tenantId,
          id: uuid(),
          name: "default",
          created_at: Date.now(),
        })
        .execute(),
    ).rejects.toThrow();
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P19 environment skill edit and rollback preserve environment scope", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const project = await identities.createProject(
      owner,
      "Env app",
      staging.id,
    );
    const store = new PackageStore(storage, root);
    const { PackageManager } = await import("../src/application/packages.js");
    const first = await store.publish(owner, {
      name: "env-skill",
      scope: "environment",
      projectId: project.id,
      baseRevision: null,
      files: FILES,
    });
    const manager = new PackageManager(store);
    const listed = await store.search(owner, {
      projectId: project.id,
      query: "env-skill",
    });
    const skillId = listed.items.find((i) => i.name === "env-skill")!.skill_id;
    const active = listed.items.find((i) => i.name === "env-skill")!.revision!;
    void first;
    const current = await store.files(owner, skillId, active);
    const hash = (await import("node:crypto"))
      .createHash("sha256")
      .update(current.files["SKILL.md"]!)
      .digest("hex");
    const edited = await manager.edit(owner, skillId, {
      base_revision: active,
      changes: [
        {
          path: "SKILL.md",
          original_hash: hash,
          content: current.files["SKILL.md"]!.toString() + "\nMore.\n",
        },
      ],
    });
    expect(edited.decision).toBe("update");
    const afterEdit = await storage.db
      .selectFrom("skills")
      .select(["scope_key", "project_id"])
      .where("tenant_id", "=", owner.tenantId)
      .where("id", "=", skillId)
      .executeTakeFirstOrThrow();
    expect(afterEdit.scope_key).toBe(`environment:${staging.id}`);
    expect(afterEdit.project_id).toBeNull();
    const rolled = await manager.rollback(
      owner,
      skillId,
      active,
      edited.revision,
    );
    expect(rolled.decision).toBe("update");
    const afterRollback = await storage.db
      .selectFrom("skills")
      .select("scope_key")
      .where("tenant_id", "=", owner.tenantId)
      .where("id", "=", skillId)
      .executeTakeFirstOrThrow();
    expect(afterRollback.scope_key).toBe(`environment:${staging.id}`);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P19 withRevision rechecks environment access for shared readers", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const pStaging = await identities.createProject(
      owner,
      "Staging app",
      staging.id,
    );
    const store = new PackageStore(storage, root);
    await store.publish(owner, {
      name: "env-skill",
      scope: "environment",
      projectId: pStaging.id,
      baseRevision: null,
      files: FILES,
    });
    const seen = await store.search(owner, {
      projectId: pStaging.id,
      query: "env-skill",
    });
    const skillId = seen.items[0]!.skill_id;
    const revision = seen.items[0]!.revision!;
    const outsider = await new MemberService(storage.db).create(owner, {
      subject: `fixture|${randomUUID()}`,
      display_name: "Writer",
      role: "writer",
    });
    const writer = { ...owner, userId: outsider.user_id };
    await new MemberService(storage.db).update(owner, outsider.user_id, {
      project_ref: pStaging.id,
      generation: 0,
      project_generation: null,
      role: "writer",
      disabled: false,
      project_role: "writer",
    });
    await expect(store.files(writer, skillId, revision)).resolves.toBeDefined();
    let entered = false;
    const slow = store.withRevision(writer, skillId, revision, async () => {
      entered = true;
      await new Promise((r) => setTimeout(r, 150));
      return "first";
    });
    for (let i = 0; i < 200 && !entered; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(entered).toBe(true);
    await storage.db
      .deleteFrom("project_members")
      .where("tenant_id", "=", owner.tenantId)
      .where("project_id", "=", pStaging.id)
      .where("user_id", "=", outsider.user_id)
      .execute();
    const second = store.withRevision(
      writer,
      skillId,
      revision,
      async () => "second",
    );
    const secondDenied = expect(second).rejects.toMatchObject({
      code: "skill_unavailable",
    });
    await expect(slow).resolves.toBe("first");
    await secondDenied;
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P19 environment removal is idempotent-safe and bindings detect content drift", async () => {
  const { root, storage, identities, owner } = await setup();
  try {
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    await expect(envs.remove(owner, staging.id)).resolves.toMatchObject({
      id: staging.id,
    });
    await expect(envs.remove(owner, staging.id)).rejects.toMatchObject({
      code: "environment_unavailable",
    });
    const project = await identities.createProject(owner, "Bound");
    const local = join(root, "drift-proj");
    await mkdir(local, { recursive: true });
    const bindings = new BindingService(storage.db);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(local, "marker.txt"), "v1");
    await bindings.bind(owner, {
      project_id: project.id,
      client_id: "codex",
      path: local,
      local_name: "drift",
    });
    expect(
      (await bindings.verify(owner, { client_id: "codex", path: local }))
        .status,
    ).toBe("bound");
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(join(local, "extra.txt"), "new-entry-changes-dir-mtime");
    expect(
      (await bindings.verify(owner, { client_id: "codex", path: local }))
        .status,
    ).toBe("stale");
    await rm(local, { recursive: true, force: true });
    expect(
      (await bindings.verify(owner, { client_id: "codex", path: local }))
        .status,
    ).toBe("stale");
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
