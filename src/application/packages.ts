import { validatePackagePath } from "../skills/paths.js";
import { sql } from "kysely";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { PackageStore, type SkillScope } from "../skills/store.js";
import { exportPackage, importPackageBounded } from "../skills/archive.js";
import type { Identity } from "./identity.js";
import { IdentityService } from "./identity.js";
import { ForgeError } from "../domain/errors.js";
export class PackageManager {
  constructor(readonly store: PackageStore) {}
  async export(identity: Identity, skillId: string, revision: string) {
    const loaded = await this.store.files(identity, skillId, revision);
    return {
      name: `${loaded.skill.name}-${revision.slice(0, 12)}.zip`,
      bytes: exportPackage(loaded.skill.name, loaded.files),
    };
  }
  async import(
    identity: Identity,
    archive: Buffer,
    scope: SkillScope,
    projectId: string,
    baseRevision: string | null,
  ) {
    await new IdentityService(this.store.storage.db).authorize(
      identity,
      scope === "workspace" ? "admin" : "write",
      projectId,
    );
    const { name, files } = await importPackageBounded(archive);
    return this.store.publish(identity, {
      name,
      files,
      scope,
      projectId,
      baseRevision,
    });
  }
  async edit(identity: Identity, skillId: string, raw: unknown) {
    const input = z
      .object({
        base_revision: z.string().regex(/^[a-f0-9]{64}$/),
        rebase: z.boolean().default(false),
        changes: z
          .array(
            z
              .object({
                path: z.string().max(240),
                original_hash: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .nullable(),
                content: z
                  .string()
                  .max(1024 * 1024)
                  .nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(16),
      })
      .strict()
      .parse(raw);
    const skill = await this.store.authorizedSkill(identity, skillId, true);
    if (skill.active_revision !== input.base_revision && !input.rebase)
      throw new ForgeError(
        "revision_conflict",
        "Aktif paket değişti; güncel sürümü okuyun.",
        409,
      );
    if (new Set(input.changes.map((c) => c.path)).size !== input.changes.length)
      throw new ForgeError(
        "duplicate_change",
        "Bir dosya aynı adayda yalnız bir kez değişebilir.",
      );
    const loaded = await this.store.files(
      identity,
      skillId,
      input.base_revision,
    );
    for (const change of input.changes) {
      validatePackagePath(change.path);
      const current = loaded.files[change.path];
      const hash = current
        ? createHash("sha256").update(current).digest("hex")
        : null;
      if (hash !== change.original_hash)
        throw new ForgeError(
          "file_conflict",
          "Dosya okunmuş taban hash'i ile eşleşmiyor.",
          409,
        );
      if (change.content === null) delete loaded.files[change.path];
      else loaded.files[change.path] = Buffer.from(change.content);
    }
    return (
      input.rebase
        ? this.store.publishRebased.bind(this.store)
        : this.store.publish.bind(this.store)
    )(identity, {
      name: skill.name,
      skillId,
      scope:
        skill.scope_key === "workspace"
          ? "workspace"
          : skill.project_id
            ? "project"
            : "personal",
      projectId: skill.project_id ?? undefined,
      baseRevision: input.base_revision,
      files: loaded.files,
    });
  }
  async configure(identity: Identity, skillId: string, raw: unknown) {
    const input = z
      .object({
        base_revision: z.string().regex(/^[a-f0-9]{64}$/),
        base_updated_at: z.number().int().nonnegative().optional(),
        managed: z.boolean().optional(),
        pinned: z.boolean().optional(),
        protected: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    const skill = await this.store.authorizedSkill(identity, skillId, true);
    if (input.archived && (skill.protected || skill.pinned || !skill.managed))
      throw new ForgeError(
        "skill_protected",
        "Korunan, sabitlenmiş veya yönetim dışı paket arşivlenemez.",
        409,
      );
    if (
      input.base_updated_at !== undefined &&
      input.base_updated_at !== skill.updated_at
    )
      throw new ForgeError(
        "revision_conflict",
        "Paket ayarları değişti; güncel durumu okuyun.",
        409,
      );
    return this.store.storage.db.transaction().execute(async (tx) => {
      await new IdentityService(tx).authorize(
        identity,
        skill.scope_key === "workspace" ? "admin" : "write",
        skill.project_id ?? undefined,
      );
      const patch = Object.fromEntries(
        Object.entries(input)
          .filter(
            ([key]) => key !== "base_revision" && key !== "base_updated_at",
          )
          .map(([key, value]) => [key, value ? 1 : 0]),
      );
      const result = await tx
        .updateTable("skills")
        .set({
          ...patch,
          updated_at: sql<number>`case when updated_at >= ${Date.now()} then updated_at + 1 else ${Date.now()} end`,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", skillId)
        .where("active_revision", "=", input.base_revision)
        .where("updated_at", "=", skill.updated_at)
        .returningAll()
        .executeTakeFirst();
      if (!result)
        throw new ForgeError(
          "revision_conflict",
          "Paket yapılandırılırken aktif sürüm değişti.",
          409,
        );
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: identity.tenantId,
          id: randomUUID(),
          user_id: identity.userId,
          project_id: skill.project_id,
          kind: "skill.configured",
          detail: JSON.stringify({ skill_id: skillId, patch }),
          created_at: Date.now(),
        })
        .execute();
      return result;
    });
  }
  async rollback(
    identity: Identity,
    skillId: string,
    targetRevision: string,
    baseRevision: string,
  ) {
    const loaded = await this.store.files(identity, skillId, targetRevision),
      skill = loaded.skill;
    return this.store.publish(identity, {
      name: skill.name,
      skillId,
      scope:
        skill.scope_key === "workspace"
          ? "workspace"
          : skill.project_id
            ? "project"
            : "personal",
      projectId: skill.project_id ?? undefined,
      baseRevision,
      files: loaded.files,
    });
  }
}
