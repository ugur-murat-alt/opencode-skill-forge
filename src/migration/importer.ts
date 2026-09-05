import { importPackageBounded } from "../skills/archive.js";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { sql } from "kysely";
import { z } from "zod";
import { PackageStore } from "../skills/store.js";
import { readPackageDirectory, validatePackagePath } from "../skills/paths.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const flagsSchema = z
  .object({ managed: z.boolean(), protected: z.boolean(), pinned: z.boolean() })
  .strict();
export class MigrationImporter {
  constructor(readonly store: PackageStore) {}
  async importPackage(actor: Identity, raw: unknown) {
    const input = z
      .object({
        source_root: z.string().min(1),
        path: z.string().min(1),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        scope: z.enum(["personal", "project"]),
        project_ref: z.string().min(1),
        flags: flagsSchema,
      })
      .strict()
      .parse(raw);
    validatePackagePath(input.path);
    if (input.path.includes("/"))
      throw new ForgeError(
        "invalid_package_root",
        "Kaynak paket kökü tek dizin olmalıdır.",
      );
    const root = resolve(input.source_root);
    return this.importSnapshot(
      actor,
      {
        path: input.path,
        checksum: input.checksum,
        scope: input.scope,
        project_ref: input.project_ref,
        flags: input.flags,
        source_id: hash(`${root}\0${input.path}`),
      },
      () => readPackageDirectory(resolve(root, input.path)),
    );
  }
  async importArchive(actor: Identity, raw: unknown, archive: Buffer) {
    const input = z
      .object({
        source_id: z.string().regex(/^[a-f0-9]{64}$/),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        scope: z.enum(["personal", "project"]),
        project_ref: z.string().min(1),
        flags: flagsSchema,
      })
      .strict()
      .parse(raw);
    await new IdentityService(this.store.storage.db).authorize(
      actor,
      "write",
      input.project_ref,
    );
    const { name, files } = await importPackageBounded(archive);
    return this.importSnapshot(
      actor,
      { ...input, path: name },
      async () => files,
    );
  }
  private async importSnapshot(
    actor: Identity,
    input: {
      path: string;
      checksum: string;
      scope: "personal" | "project";
      project_ref: string;
      flags: z.infer<typeof flagsSchema>;
      source_id: string;
    },
    load: () => Promise<Record<string, Buffer>>,
  ) {
    await new IdentityService(this.store.storage.db).authorize(
      actor,
      "write",
      input.project_ref,
    );
    const sourceId = input.source_id,
      id = hash(
        JSON.stringify([
          actor.tenantId,
          actor.userId,
          input.project_ref,
          input.scope,
          sourceId,
          input.checksum,
          input.flags,
        ]),
      );
    const old = await this.store.storage.db
      .selectFrom("migration_receipts")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (old)
      return {
        receipt_id: id,
        skill_id: old.skill_id,
        revision: old.revision,
        state: old.state,
        replayed: true,
      };
    const files = await load();
    const manifest = Object.keys(files)
      .sort()
      .map((path) => ({
        path,
        bytes: files[path]!.length,
        sha256: hash(files[path]!),
      }));
    if (hash(JSON.stringify(manifest)) !== input.checksum)
      throw new ForgeError(
        "source_changed",
        "Kaynak checksum değişti; yeni keşif gerekiyor.",
        409,
      );
    try {
      const result = await this.store.publish(actor, {
        name: input.path,
        scope: input.scope,
        projectId: input.project_ref,
        baseRevision: null,
        files,
        importReceipt: {
          id,
          sourceId,
          sourceChecksum: input.checksum,
          flags: input.flags,
        },
      });
      return { ...result, receipt_id: id, state: "applied", replayed: false };
    } catch (error) {
      const receipt = await this.store.storage.db
        .selectFrom("migration_receipts")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (receipt)
        return {
          receipt_id: id,
          skill_id: receipt.skill_id,
          revision: receipt.revision,
          state: receipt.state,
          replayed: true,
        };
      throw error;
    }
  }
  async rollback(actor: Identity, id: string) {
    return this.store.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const receipt = await tx
        .selectFrom("migration_receipts")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (!receipt)
        throw new ForgeError(
          "migration_unavailable",
          "Aktarım kaydı bulunamadı.",
          404,
        );
      await new IdentityService(tx).authorize(
        actor,
        "write",
        receipt.project_id,
      );
      if (receipt.state === "rolled_back")
        return { receipt_id: id, state: "rolled_back", replayed: true };
      const flags = flagsSchema.parse(JSON.parse(receipt.flags_json));
      const updated = await tx
        .updateTable("skills")
        .set({ archived: 1, updated_at: sql`updated_at + 1` })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", receipt.skill_id)
        .where("active_revision", "=", receipt.revision)
        .where("archived", "=", 0)
        .where("managed", "=", flags.managed ? 1 : 0)
        .where("protected", "=", flags.protected ? 1 : 0)
        .where("pinned", "=", flags.pinned ? 1 : 0)
        .where("updated_at", "=", receipt.skill_generation)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1)
        throw new ForgeError(
          "migration_target_changed",
          "Hedef paket değişti; geri alma durduruldu.",
          409,
        );
      await tx
        .updateTable("migration_receipts")
        .set({ state: "rolled_back", updated_at: Date.now() })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .execute();
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          user_id: actor.userId,
          project_id: receipt.project_id,
          kind: "migration.rolled_back",
          detail: JSON.stringify({
            receipt_id: id,
            skill_id: receipt.skill_id,
            revision: receipt.revision,
          }),
          created_at: Date.now(),
        })
        .execute();
      return { receipt_id: id, state: "rolled_back", replayed: false };
    });
  }
}
