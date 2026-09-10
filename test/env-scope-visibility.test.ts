import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
import { EnvironmentService } from "../src/application/environments.js";
import { PackageStore } from "../src/skills/store.js";
import { MaintenanceService } from "../src/application/maintenance.js";
import { DeletionService } from "../src/application/deletion.js";

function skill(name: string) {
  return {
    "SKILL.md": Buffer.from(
      `---\nname: ${name}\ndescription: Environment visibility fixture.\n---\nBody.\n`,
    ),
  };
}

/** Issue #14: environment packages visible in search must also appear in the
 * dashboard stats and maintenance/deletion flows under one scope contract. */
test("P2 #14 dashboard, maintenance and deletion see environment packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-env-vis-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const project = await identities.createProject(
      owner,
      "Visible",
      staging.id,
    );
    const store = new PackageStore(storage, root);
    await store.publish(owner, {
      name: "workspace-skill",
      scope: "workspace",
      baseRevision: null,
      files: skill("workspace-skill"),
    });
    await store.publish(owner, {
      name: "personal-skill",
      scope: "personal",
      baseRevision: null,
      files: skill("personal-skill"),
    });
    await store.publish(owner, {
      name: "project-skill",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: skill("project-skill"),
    });
    const envSkill = await store.publish(owner, {
      name: "env-skill",
      scope: "environment",
      projectId: project.id,
      baseRevision: null,
      files: skill("env-skill"),
    });
    // Aramada görünen ortam paketi bakım listesinde de görünür.
    const maintenance = new MaintenanceService(storage, root);
    const report = await maintenance.report(owner, project.id, {
      state: "all",
    });
    const names = report.items.map((item) => item.name);
    expect(names).toContain("env-skill");
    expect(names).toEqual(
      expect.arrayContaining([
        "workspace-skill",
        "personal-skill",
        "project-skill",
        "env-skill",
      ]),
    );
    // Yetkili admin ortam paketini archive → restore akışına alır.
    const archivedSkill = await store.authorizedSkill(owner, envSkill.skill_id);
    await maintenance.apply(owner, {
      project_ref: project.id,
      operation_id: randomUUID(),
      action: "archive",
      items: [
        {
          skill_id: envSkill.skill_id,
          revision: envSkill.revision,
          updated_at: archivedSkill.updated_at,
        },
      ],
    });
    const archived = await store.authorizedSkill(owner, envSkill.skill_id);
    await maintenance.apply(owner, {
      project_ref: project.id,
      operation_id: randomUUID(),
      action: "restore",
      items: [
        {
          skill_id: envSkill.skill_id,
          revision: envSkill.revision,
          updated_at: archived.updated_at,
        },
      ],
    });
    // Silme önizleme akışı da ortam paketini görür (referans yoksa eligible).
    const deletion = new DeletionService(storage, root);
    const envAfter = await store.authorizedSkill(owner, envSkill.skill_id);
    await maintenance.apply(owner, {
      project_ref: project.id,
      operation_id: randomUUID(),
      action: "archive",
      items: [
        {
          skill_id: envSkill.skill_id,
          revision: envSkill.revision,
          updated_at: envAfter.updated_at,
        },
      ],
    });
    if (process.platform === "linux") {
      const preview = await deletion.preview(owner, {
        project_ref: project.id,
        operation_id: randomUUID(),
        action: "delete",
        items: [
          {
            skill_id: envSkill.skill_id,
            revision: envSkill.revision,
            updated_at: (await store.authorizedSkill(owner, envSkill.skill_id))
              .updated_at,
          },
        ],
      });
      expect(preview.items[0]).toMatchObject({ status: "eligible" });
    }
    // Yetkisiz üye: listelerde görünür (okuma), mutasyon reddedilir.
    const members = new MemberService(storage.db);
    const writer = await members.create(owner, {
      subject: `fixture|${randomUUID()}`,
      display_name: "Writer",
      role: "writer",
    });
    await members.update(owner, writer.user_id, {
      project_ref: project.id,
      generation: 0,
      project_generation: null,
      role: "writer",
      disabled: false,
      project_role: "writer",
    });
    const writerIdentity: Identity = { ...owner, userId: writer.user_id };
    const writerReport = await maintenance.report(writerIdentity, project.id, {
      state: "all",
    });
    expect(writerReport.items.map((i) => i.name)).toContain("env-skill");
    const writerArchived = await store.authorizedSkill(
      writerIdentity,
      envSkill.skill_id,
    );
    const writerApply = await maintenance.apply(writerIdentity, {
      project_ref: project.id,
      operation_id: randomUUID(),
      action: "archive",
      items: [
        {
          skill_id: envSkill.skill_id,
          revision: envSkill.revision,
          updated_at: writerArchived.updated_at,
        },
      ],
    });
    // Yetkisiz üye: madde düzeyinde reddedilir (yazılmaz).
    expect(writerApply.items[0]).toMatchObject({
      status: "blocked",
      error: { code: "forbidden" },
    });
    // Proje ortamı değişince tüm tüketiciler aynı sonucu verir.
    const other = await envs.create(owner, { name: "other" });
    await storage.db
      .updateTable("projects")
      .set({ environment_id: other.id })
      .where("tenant_id", "=", owner.tenantId)
      .where("id", "=", project.id)
      .execute();
    const moved = await maintenance.report(owner, project.id, { state: "all" });
    expect(moved.items.map((i) => i.name)).toContain("project-skill");
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
