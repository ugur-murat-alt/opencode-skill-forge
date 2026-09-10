import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { EnvironmentService } from "../src/application/environments.js";
import { PackageStore } from "../src/skills/store.js";
import { PackageManager } from "../src/application/packages.js";

function skill(name: string, description: string) {
  return {
    "SKILL.md": Buffer.from(
      `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`,
    ),
  };
}

/** Issue #7: an environment skill whose last project left the environment
 * must stay editable/rollbackable by an authorized manager, keeping scope. */
test("P2 #7 orphaned environment package edit and rollback keep its scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-env-orphan-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const envs = new EnvironmentService(storage.db);
    const staging = await envs.create(owner, { name: "staging" });
    const other = await envs.create(owner, { name: "other" });
    const project = await identities.createProject(owner, "Rep", staging.id);
    const store = new PackageStore(storage, root);
    const packages = new PackageManager(store);
    const first = await store.publish(owner, {
      name: "env-orphan",
      scope: "environment",
      projectId: project.id,
      baseRevision: null,
      files: skill("env-orphan", "Orphan v1."),
    });
    const second = await store.publish(owner, {
      name: "env-orphan",
      scope: "environment",
      projectId: project.id,
      baseRevision: first.revision,
      files: skill("env-orphan", "Orphan v2."),
    });
    expect(second.revision).not.toBe(first.revision);
    // Son projeyi ortamdan çıkar: temsilci proje kalmaz.
    await storage.db
      .updateTable("projects")
      .set({ environment_id: other.id })
      .where("id", "=", project.id)
      .execute();
    // Edit: mevcut SKILL.md satırını değiştir, yetkili yönetici olarak.
    const loaded = await store.files(owner, first.skill_id, second.revision);
    const current = loaded.files["SKILL.md"]!;
    const edited = Buffer.from(current)
      .toString("utf8")
      .replace("Orphan v2.", "Orphan v3.");
    const edit = await packages.edit(owner, first.skill_id, {
      base_revision: second.revision,
      changes: [
        {
          path: "SKILL.md",
          original_hash: createHash("sha256").update(current).digest("hex"),
          content: edited,
        },
      ],
    });
    expect(edit.revision).not.toBe(second.revision);
    const afterEdit = await storage.db
      .selectFrom("skills")
      .select("scope_key")
      .where("id", "=", first.skill_id)
      .executeTakeFirst();
    expect(afterEdit!.scope_key).toBe(`environment:${staging.id}`);
    // Rollback ikinci revizyona; scope aynı kalır.
    await packages.rollback(
      owner,
      first.skill_id,
      second.revision,
      edit.revision,
    );
    const afterRollback = await storage.db
      .selectFrom("skills")
      .select("scope_key")
      .where("id", "=", first.skill_id)
      .executeTakeFirst();
    expect(afterRollback!.scope_key).toBe(`environment:${staging.id}`);
    // Yeni ortam paketi hâlâ açık bağlam ister.
    await expect(
      store.publish(owner, {
        name: "env-fresh",
        scope: "environment",
        baseRevision: null,
        files: skill("env-fresh", "Fresh."),
      }),
    ).rejects.toMatchObject({ code: "project_required" });
    // Başka tenant yazma açılmaz (çapraz tenant 404: varlık sızdırılmaz).
    await expect(
      store.publish(
        { ...owner, tenantId: "foreign" },
        {
          name: "env-orphan",
          skillId: first.skill_id,
          scope: "environment",
          baseRevision: null,
          files: skill("env-orphan", "Foreign."),
        },
      ),
    ).rejects.toMatchObject({ code: "skill_unavailable" });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
