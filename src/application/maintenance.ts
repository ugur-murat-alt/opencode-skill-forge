import { DeletionService } from "./deletion.js";
import { scopeWritePermission } from "../skills/store.js";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { DatabaseHandle } from "../storage/database.js";
import type { DB } from "../storage/schema.js";
import { IdentityService, type Identity } from "./identity.js";
import { ForgeError, errorEnvelope } from "../domain/errors.js";

const itemSchema = z
  .object({
    skill_id: z.string().min(1).max(100),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();
export const maintenanceSchema = z
  .object({
    project_ref: z.string().min(1).max(100),
    operation_id: z.string().min(1).max(200),
    action: z.enum(["archive", "restore", "delete"]),
    items: z.array(itemSchema).min(1).max(100),
  })
  .strict();
/** Bounded, deterministic, private observation report and replay-safe item transactions. */
export class MaintenanceService {
  constructor(
    readonly storage: DatabaseHandle,
    readonly dataDir?: string,
  ) {}
  private async skill(
    db: Kysely<DB>,
    actor: Identity,
    project: string,
    id: string,
  ) {
    const row = await db
      .selectFrom("skills")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("id", "=", id)
      .where("scope_key", "in", [
        "workspace",
        `personal:${actor.userId}`,
        `project:${project}`,
      ])
      .executeTakeFirst();
    if (!row)
      throw new ForgeError(
        "skill_unavailable",
        "Paket bu kapsamda bulunamadı.",
        404,
      );
    return row;
  }
  private async check(
    db: Kysely<DB>,
    actor: Identity,
    project: string,
    action: "archive" | "restore",
    item: z.infer<typeof itemSchema>,
  ) {
    const row = await this.skill(db, actor, project, item.skill_id);
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
        "Paket önizlemeden sonra değişti; listeyi yenileyin.",
        409,
      );
    if (action === "archive" && (row.pinned || row.protected || !row.managed))
      throw new ForgeError(
        "skill_protected",
        "Sabitlenmiş, korunan veya yönetim dışı paket arşivlenemez.",
        409,
      );
    return row;
  }
  async report(
    actor: Identity,
    project: string,
    options: {
      days?: number;
      limit?: number;
      after?: string;
      state?: "active" | "archived" | "all";
    } = {},
  ) {
    await new IdentityService(this.storage.db).authorize(
      actor,
      "read",
      project,
    );
    const days = z
        .number()
        .int()
        .min(1)
        .max(365)
        .parse(options.days ?? 30),
      since = Date.now() - days * 86400000;
    let query = this.storage.db
      .selectFrom("skills")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("scope_key", "in", [
        "workspace",
        `personal:${actor.userId}`,
        `project:${project}`,
      ]);
    if (options.after) query = query.where("id", ">", options.after);
    if (options.state && options.state !== "all")
      query = query.where(
        "archived",
        "=",
        options.state === "archived" ? 1 : 0,
      );
    const limit = z
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(options.limit ?? 50);
    const rows = await query
      .orderBy("id")
      .limit(limit + 1)
      .execute();
    const selected = rows.slice(0, limit),
      ids = selected.map((s) => s.id);
    const counts = ids.length
      ? await this.storage.db
          .selectFrom("skill_observations")
          .select(["skill_id", "kind"])
          .select((eb) => [
            eb.fn.countAll<number>().as("count"),
            eb.fn.max<number>("created_at").as("last_seen"),
          ])
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .where("project_id", "=", project)
          .where("skill_id", "in", ids)
          .where("created_at", ">=", since)
          .groupBy(["skill_id", "kind"])
          .execute()
      : [];
    const items = selected.map((row) => {
      const observations = Object.fromEntries(
        counts
          .filter((c) => c.skill_id === row.id)
          .map((c) => [
            c.kind,
            { count: Number(c.count), last_seen: c.last_seen },
          ]),
      );
      const grace = row.created_at > Date.now() - 7 * 86400000;
      const reason = row.archived
        ? "archived"
        : grace
          ? "new_skill_grace"
          : !observations.search_impression
            ? "not_observed_in_search"
            : !observations.loaded
              ? "visible_not_loaded"
              : "loaded_outcome_unknown";
      return {
        skill_id: row.id,
        name: row.name,
        scope: row.scope_key,
        revision: row.active_revision,
        updated_at: row.updated_at,
        created_at: row.created_at,
        archived: !!row.archived,
        protected: !!row.protected,
        pinned: !!row.pinned,
        managed: !!row.managed,
        observations,
        reported_applied: null,
        outcome_observed: null,
        reason,
      };
    });
    return {
      window: { since, until: Date.now(), days },
      observation_scope: "current_user_project_service_calls",
      window_complete: false,
      retention_may_limit_window: true,
      external_usage: "unknown",
      grace_days: 7,
      items,
      next: rows.length > limit ? selected.at(-1)!.id : null,
    };
  }
  async preview(actor: Identity, raw: unknown) {
    const input = maintenanceSchema.parse(raw);
    if (input.action === "delete")
      return new DeletionService(this.storage, this.dataDir).preview(actor, {
        ...input,
        action: "delete",
      });
    await new IdentityService(this.storage.db).authorize(
      actor,
      "write",
      input.project_ref,
    );
    const items = [];
    for (const item of input.items) {
      try {
        const row = await this.check(
          this.storage.db,
          actor,
          input.project_ref,
          input.action,
          item,
        );
        items.push({
          skill_id: row.id,
          name: row.name,
          status: "eligible",
          existing_revisions: "preserved",
          action: input.action,
        });
      } catch (error) {
        items.push({
          skill_id: item.skill_id,
          status: "blocked",
          ...errorEnvelope(error),
        });
      }
    }
    return {
      action: input.action,
      items,
      effect:
        input.action === "archive"
          ? "Yeni keşiften çıkarır; sabit sürümleri ve devam eden işleri korur."
          : "Aynı kimlik ve sürümle keşfe geri alır.",
    };
  }
  async apply(actor: Identity, raw: unknown) {
    const input = maintenanceSchema.parse(raw);
    if (input.action === "delete")
      return new DeletionService(this.storage, this.dataDir).apply(actor, {
        ...input,
        action: "delete",
      });
    const action = input.action;
    if (new Set(input.items.map((i) => i.skill_id)).size !== input.items.length)
      throw new ForgeError("duplicate_item", "Aynı paket iki kez seçilemez.");
    await new IdentityService(this.storage.db).authorize(
      actor,
      "write",
      input.project_ref,
    );
    const items = [];
    for (const item of input.items) {
      try {
        items.push(
          await this.storage.db.transaction().execute(async (tx) => {
            // Serialize with membership/project revocation before authorization and mutation.
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
            const hash = createHash("sha256")
              .update(JSON.stringify({ action: action, item }))
              .digest("hex");
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
              // Revoked access is still denied on replay.
              const skill = await this.skill(
                tx,
                actor,
                input.project_ref,
                item.skill_id,
              );
              await new IdentityService(tx).authorize(
                actor,
                scopeWritePermission(skill.scope_key),
                input.project_ref,
              );
              if (receipt.input_hash !== hash)
                throw new ForgeError(
                  "idempotency_conflict",
                  "İşlem anahtarı başka seçime ait.",
                  409,
                );
              return { ...JSON.parse(receipt.result_json), replayed: true };
            }
            const row = await this.check(
              tx,
              actor,
              input.project_ref,
              action,
              item,
            );
            const updated = await tx
              .updateTable("skills")
              .set({
                archived: action === "archive" ? 1 : 0,
                updated_at: Math.max(Date.now(), row.updated_at + 1),
              })
              .where("tenant_id", "=", actor.tenantId)
              .where("id", "=", row.id)
              .where("active_revision", "=", item.revision)
              .where("updated_at", "=", item.updated_at)
              .returning("id")
              .executeTakeFirst();
            if (!updated)
              throw new ForgeError(
                "revision_conflict",
                "Paket başka işlemle değişti.",
                409,
              );
            const result = {
              skill_id: row.id,
              status: "completed",
              action: action,
            };
            await tx
              .insertInto("maintenance_items")
              .values({
                tenant_id: actor.tenantId,
                user_id: actor.userId,
                project_id: input.project_ref,
                operation_id: input.operation_id,
                skill_id: row.id,
                input_hash: hash,
                result_json: JSON.stringify(result),
                created_at: Date.now(),
              })
              .execute();
            await tx
              .insertInto("audit_events")
              .values({
                tenant_id: actor.tenantId,
                user_id: actor.userId,
                project_id: input.project_ref,
                id: randomUUID(),
                kind: `maintenance.${action}`,
                detail: JSON.stringify({
                  ...result,
                  operation_id: input.operation_id,
                }),
                created_at: Date.now(),
              })
              .execute();
            return result;
          }),
        );
      } catch (error) {
        items.push({
          skill_id: item.skill_id,
          status: "blocked",
          ...errorEnvelope(error),
        });
      }
    }
    return { operation_id: input.operation_id, items };
  }
}
