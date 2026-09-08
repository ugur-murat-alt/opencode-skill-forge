import { createHash, randomUUID } from "node:crypto";
import { scopeWritePermission } from "../skills/store.js";
import { sql, type Kysely } from "kysely";
import type { DatabaseHandle } from "../storage/database.js";
import type { DB } from "../storage/schema.js";
import { IdentityService, type Identity } from "./identity.js";
import { ForgeError, errorEnvelope } from "../domain/errors.js";
import { removeRevision } from "../skills/remove.js";
interface Input {
  project_ref: string;
  operation_id: string;
  action: "delete";
  items: { skill_id: string; revision: string; updated_at: number }[];
}
export class DeletionService {
  constructor(
    readonly storage: DatabaseHandle,
    readonly dataDir?: string,
  ) {}
  private async check(
    db: Kysely<DB>,
    actor: Identity,
    project: string,
    item: Input["items"][number],
  ) {
    await new IdentityService(db).authorize(actor, "write", project);
    const row = await db
      .selectFrom("skills")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("id", "=", item.skill_id)
      .where("scope_key", "in", [
        "workspace",
        `personal:${actor.userId}`,
        `project:${project}`,
      ])
      .executeTakeFirst();
    if (!row)
      throw new ForgeError("skill_unavailable", "Paket bulunamadı.", 404);
    await new IdentityService(db).authorize(
      actor,
      scopeWritePermission(row.scope_key),
      project,
    );
    if (
      row.active_revision !== item.revision ||
      row.updated_at !== item.updated_at
    )
      throw new ForgeError(
        "revision_conflict",
        "Paket önizlemeden sonra değişti.",
        409,
      );
    if (!row.archived || row.pinned || row.protected || !row.managed)
      throw new ForgeError(
        "skill_protected",
        "Kalıcı silme yalnız arşivlenmiş, managed ve korunmayan paket içindir.",
        409,
      );
    const tables = [
      "revision_readers",
      "execution_revision_pins",
      "run_revision_pins",
      "migration_receipts",
      "skill_observations",
      "skill_overrides",
    ] as const;
    const labels: Record<(typeof tables)[number], string> = {
      revision_readers: "devam eden okuma",
      execution_revision_pins: "script çalıştırması",
      run_revision_pins: "SPR işi",
      migration_receipts: "veri geçişi kaydı",
      skill_observations: "kullanım geçmişi",
      skill_overrides: "proje override kaydı",
    };
    const references: string[] = [];
    for (const table of tables)
      if (
        await db
          .selectFrom(table)
          .select("skill_id")
          .where("tenant_id", "=", actor.tenantId)
          .where("skill_id", "=", row.id)
          .limit(1)
          .executeTakeFirst()
      )
        references.push(labels[table]);
    const unknownExecutions = await db
      .selectFrom("executions as e")
      .leftJoin("execution_revision_pins as p", (j) =>
        j
          .onRef("p.tenant_id", "=", "e.tenant_id")
          .onRef("p.execution_id", "=", "e.id"),
      )
      .select("e.id")
      .where("e.tenant_id", "=", actor.tenantId)
      .where("e.state", "=", "running")
      .where("p.execution_id", "is", null)
      .limit(1)
      .executeTakeFirst();
    const unknownRuns = await db
      .selectFrom("runs as r")
      .leftJoin("run_revision_pins as p", (j) =>
        j
          .onRef("p.tenant_id", "=", "r.tenant_id")
          .onRef("p.run_id", "=", "r.id"),
      )
      .select("r.id")
      .where("r.tenant_id", "=", actor.tenantId)
      .where("r.state", "=", "running")
      .where("p.run_id", "is", null)
      .limit(1)
      .executeTakeFirst();
    if (unknownExecutions || unknownRuns)
      references.push("revision bilgisi bulunmayan çalışan iş");
    if (references.length)
      throw new ForgeError(
        "skill_referenced",
        `Paket referansları korunuyor: ${references.join(", ")}`,
        409,
      );
    return row;
  }
  async preview(actor: Identity, input: Input) {
    if (!this.dataDir || process.platform !== "linux")
      throw new ForgeError(
        "safe_delete_unavailable",
        "Güvenli dosya silme adapter'ı bu ortamda hazır değil.",
        503,
      );
    await new IdentityService(this.storage.db).authorize(
      actor,
      "write",
      input.project_ref,
    );
    const items = [];
    for (const item of input.items)
      try {
        const row = await this.check(
          this.storage.db,
          actor,
          input.project_ref,
          item,
        );
        const count = await this.storage.db
          .selectFrom("skill_revisions")
          .select(sql<number>`count(*)`.as("n"))
          .where("tenant_id", "=", actor.tenantId)
          .where("skill_id", "=", row.id)
          .executeTakeFirstOrThrow();
        items.push({
          revision_count: Number(count.n),
          skill_id: row.id,
          name: row.name,
          status: "eligible",
          action: "delete",
          existing_revisions: "removed",
        });
      } catch (error) {
        items.push({
          skill_id: item.skill_id,
          status: "blocked",
          ...errorEnvelope(error),
        });
      }
    return {
      action: "delete",
      items,
      effect:
        "Paket ve bütün revision dosyaları kalıcı silinir. Geri alınamaz. Aktif referanslar engellenir; mevcut yedekler etkilenmez.",
    };
  }
  async pending(actor: Identity, project: string, after = "") {
    await new IdentityService(this.storage.db).authorize(
      actor,
      "write",
      project,
    );
    const rows = await this.storage.db
      .selectFrom("package_deletions as d")
      .select(["d.skill_id", "d.scope_key", "d.created_at"])
      .where("d.tenant_id", "=", actor.tenantId)
      .where("d.scope_key", "in", [
        "workspace",
        `personal:${actor.userId}`,
        `project:${project}`,
      ])
      .where("d.skill_id", ">", after)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("package_gc as g")
            .select("g.revision")
            .whereRef("g.tenant_id", "=", "d.tenant_id")
            .whereRef("g.skill_id", "=", "d.skill_id")
            .where("g.state", "=", "pending"),
        ),
      )
      .orderBy("d.skill_id")
      .limit(51)
      .execute();
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49]!.skill_id : null,
    };
  }
  async resume(actor: Identity, project: string, skillId: string) {
    await new IdentityService(this.storage.db).authorize(
      actor,
      "write",
      project,
    );
    const row = await this.storage.db
      .selectFrom("package_deletions")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("skill_id", "=", skillId)
      .where("scope_key", "in", [
        "workspace",
        `personal:${actor.userId}`,
        `project:${project}`,
      ])
      .executeTakeFirst();
    if (!row)
      throw new ForgeError("skill_unavailable", "Silme kaydı bulunamadı.", 404);
    await new IdentityService(this.storage.db).authorize(
      actor,
      scopeWritePermission(row.scope_key),
      project,
    );
    if (!this.dataDir || process.platform !== "linux")
      throw new ForgeError(
        "safe_delete_unavailable",
        "Güvenli dosya silme adapter'ı bu ortamda hazır değil.",
        503,
      );
    return this.cleanup(actor, skillId);
  }
  private async cleanup(actor: Identity, skillId: string) {
    const pending = await this.storage.db
      .selectFrom("package_gc")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("skill_id", "=", skillId)
      .where("state", "=", "pending")
      .orderBy("revision")
      .limit(25)
      .execute();
    let cleanupError: ReturnType<typeof errorEnvelope> | undefined;
    for (const revision of pending)
      try {
        await removeRevision(
          this.dataDir!,
          actor.tenantId,
          revision.package_path,
          skillId,
          revision.revision,
        );
        await this.storage.db
          .updateTable("package_gc")
          .set({ state: "completed", updated_at: Date.now() })
          .where("tenant_id", "=", actor.tenantId)
          .where("skill_id", "=", skillId)
          .where("revision", "=", revision.revision)
          .execute();
      } catch (error) {
        cleanupError = errorEnvelope(error);
        break;
      }
    const remaining = await this.storage.db
      .selectFrom("package_gc")
      .select("revision")
      .where("tenant_id", "=", actor.tenantId)
      .where("skill_id", "=", skillId)
      .where("state", "=", "pending")
      .limit(1)
      .executeTakeFirst();
    const result = {
      skill_id: skillId,
      action: "delete",
      status: remaining ? "pending_cleanup" : "completed",
      ...cleanupError,
    };
    return result;
  }
  async apply(actor: Identity, input: Input) {
    if (!this.dataDir || process.platform !== "linux")
      throw new ForgeError(
        "safe_delete_unavailable",
        "Güvenli dosya silme adapter'ı bu ortamda hazır değil.",
        503,
      );
    if (new Set(input.items.map((i) => i.skill_id)).size !== input.items.length)
      throw new ForgeError("duplicate_item", "Aynı paket iki kez seçilemez.");
    await new IdentityService(this.storage.db).authorize(
      actor,
      "write",
      input.project_ref,
    );
    const items = [];
    for (const item of input.items)
      try {
        const hash = createHash("sha256")
          .update(JSON.stringify({ action: "delete", item }))
          .digest("hex");
        await this.storage.db.transaction().execute(async (tx) => {
          await tx
            .updateTable("tenants")
            .set({ name: sql`name` })
            .where("id", "=", actor.tenantId)
            .execute();
          await new IdentityService(tx).authorize(
            actor,
            "write",
            input.project_ref,
          );
          const receipt = await tx
            .selectFrom("maintenance_items")
            .selectAll()
            .where("tenant_id", "=", actor.tenantId)
            .where("user_id", "=", actor.userId)
            .where("project_id", "=", input.project_ref)
            .where("operation_id", "=", input.operation_id)
            .where("skill_id", "=", item.skill_id)
            .executeTakeFirst();
          if (receipt) {
            if (receipt.input_hash !== hash)
              throw new ForgeError(
                "idempotency_conflict",
                "İşlem anahtarı başka seçime ait.",
                409,
              );
            const tombstone = await tx
              .selectFrom("package_deletions")
              .selectAll()
              .where("tenant_id", "=", actor.tenantId)
              .where("skill_id", "=", item.skill_id)
              .executeTakeFirstOrThrow();
            await new IdentityService(tx).authorize(
              actor,
              scopeWritePermission(tombstone.scope_key),
              input.project_ref,
            );
            return;
          }
          const row = await this.check(tx, actor, input.project_ref, item);
          const changed = await tx
            .updateTable("skills")
            .set({ active_revision: null })
            .where("tenant_id", "=", actor.tenantId)
            .where("id", "=", row.id)
            .where("active_revision", "=", item.revision)
            .where("updated_at", "=", item.updated_at)
            .returning("id")
            .executeTakeFirst();
          if (!changed)
            throw new ForgeError(
              "revision_conflict",
              "Paket başka işlemle değişti.",
              409,
            );
          const now = Date.now();
          await sql`INSERT INTO package_gc (tenant_id, skill_id, revision, package_path, state, updated_at) SELECT tenant_id, skill_id, revision, package_path, 'pending', ${now} FROM skill_revisions WHERE tenant_id=${actor.tenantId} AND skill_id=${row.id}`.execute(
            tx,
          );
          await tx
            .deleteFrom("skill_revisions")
            .where("tenant_id", "=", actor.tenantId)
            .where("skill_id", "=", row.id)
            .execute();
          await tx
            .deleteFrom("skills")
            .where("tenant_id", "=", actor.tenantId)
            .where("id", "=", row.id)
            .execute();
          await tx
            .insertInto("package_deletions")
            .values({
              tenant_id: actor.tenantId,
              skill_id: row.id,
              scope_key: row.scope_key,
              created_at: now,
            })
            .execute();
          await tx
            .insertInto("maintenance_items")
            .values({
              tenant_id: actor.tenantId,
              user_id: actor.userId,
              project_id: input.project_ref,
              operation_id: input.operation_id,
              skill_id: row.id,
              input_hash: hash,
              result_json: JSON.stringify({
                skill_id: row.id,
                action: "delete",
                status: "pending_cleanup",
              }),
              created_at: now,
            })
            .execute();
          await tx
            .insertInto("audit_events")
            .values({
              tenant_id: actor.tenantId,
              id: randomUUID(),
              user_id: actor.userId,
              project_id: input.project_ref,
              kind: "maintenance.delete",
              detail: JSON.stringify({
                skill_id: row.id,
                operation_id: input.operation_id,
              }),
              created_at: now,
            })
            .execute();
        });
        const result = await this.cleanup(actor, item.skill_id);
        await this.storage.db
          .updateTable("maintenance_items")
          .set({ result_json: JSON.stringify(result) })
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .where("project_id", "=", input.project_ref)
          .where("operation_id", "=", input.operation_id)
          .where("skill_id", "=", item.skill_id)
          .execute();
        items.push(result);
      } catch (error) {
        items.push({
          skill_id: item.skill_id,
          status: "blocked",
          ...errorEnvelope(error),
        });
      }
    return { operation_id: input.operation_id, items };
  }
}
