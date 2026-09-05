import { createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { DatabaseHandle } from "../storage/database.js";
import { IdentityService, type Identity } from "../application/identity.js";
import {
  SessionPreferences,
  sessionSourceSchema,
  sessionValuesSchema,
  type SessionSource,
} from "../application/session-preferences.js";
import { ForgeError } from "../domain/errors.js";
const hash = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
export const flagMappingSchema = z
  .array(
    z
      .object({
        legacy_session: z.string().min(1).max(200),
        target: sessionSourceSchema,
        base_revision: z.number().int().nonnegative(),
        defaults: z
          .object({ enabled: z.boolean(), autoAccept: z.boolean() })
          .strict(),
      })
      .strict(),
  )
  .min(1)
  .max(1000);
type Change = {
  index: number;
  target: SessionSource;
  before: z.infer<typeof sessionValuesSchema>;
  applied_revision: number;
};
export class FlagMigration {
  constructor(readonly storage: DatabaseHandle) {}
  async import(
    actor: Identity,
    project: string,
    sourceId: string,
    checksum: string,
    bytes: Buffer,
    rawMapping: unknown,
  ) {
    const mapping = flagMappingSchema.parse(rawMapping),
      prefs = new SessionPreferences(new IdentityService(this.storage.db));
    if (
      new Set(mapping.map((x) => prefs.key(x.target))).size !== mapping.length
    )
      throw new ForgeError(
        "duplicate_target",
        "Aynı hedef oturum birden fazla eşlenemez.",
      );
    if (
      bytes.length > 16 * 1024 * 1024 ||
      hash(bytes) !== checksum ||
      !/^[a-f0-9]{64}$/.test(sourceId)
    )
      throw new ForgeError(
        "source_changed",
        "Bayrak kaynağı checksum/boyut doğrulaması başarısız.",
        409,
      );
    const id = hash(
      JSON.stringify([
        actor.tenantId,
        actor.userId,
        project,
        sourceId,
        checksum,
        mapping,
      ]),
    );
    return this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const identity = new IdentityService(tx),
        sessions = new SessionPreferences(identity);
      await identity.authorize(actor, "write", project);
      const old = await tx
        .selectFrom("flag_imports")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (old) {
        const report = JSON.parse(old.report_json);
        return {
          receipt_id: id,
          state: old.state,
          replayed: true,
          records: report.records,
          review_required: report.review_required,
          unselected: report.unselected,
        };
      }
      const total = await tx
        .selectFrom("flag_imports")
        .select(sql<number>`coalesce(sum(original_bytes),0)`.as("bytes"))
        .where("tenant_id", "=", actor.tenantId)
        .executeTakeFirstOrThrow();
      if (Number(total.bytes) + bytes.length > 128 * 1024 * 1024)
        throw new ForgeError(
          "migration_quota",
          "Bayrak arşivi tenant başına 128 MiB sınırını aşamaz.",
          409,
        );
      let source: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          source = parsed;
      } catch {}
      const changes: Change[] = [],
        records: {
          index: number;
          status: string;
          reason?: string;
          revision?: number;
        }[] = [];
      for (const [index, selection] of mapping.entries()) {
        if (!source || !Object.hasOwn(source, selection.legacy_session)) {
          records.push({
            index,
            status: "review_required",
            reason: source ? "source_session_missing" : "malformed_document",
          });
          continue;
        }
        const record = source[selection.legacy_session];
        let values: { promptEnabled: boolean; autoApply: boolean },
          malformed = false;
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          values = { promptEnabled: true, autoApply: false };
          malformed = true;
        } else {
          const flags = record as Record<string, unknown>;
          malformed =
            (Object.hasOwn(flags, "enabled") &&
              typeof flags.enabled !== "boolean") ||
            (Object.hasOwn(flags, "autoAccept") &&
              typeof flags.autoAccept !== "boolean");
          values = {
            promptEnabled:
              typeof flags.enabled === "boolean"
                ? flags.enabled
                : selection.defaults.enabled,
            autoApply: malformed
              ? false
              : typeof flags.autoAccept === "boolean"
                ? flags.autoAccept
                : selection.defaults.autoAccept,
          };
        }
        const before = await sessions.get(actor, project, selection.target);
        if (before.revision !== selection.base_revision) {
          records.push({
            index,
            status: "review_required",
            reason: "revision_conflict",
          });
          continue;
        }
        const applied = await sessions.write(
          tx,
          actor,
          project,
          selection.target,
          selection.base_revision,
          values,
        );
        changes.push({
          index,
          target: selection.target,
          before: before.values,
          applied_revision: applied.revision,
        });
        records.push({
          index,
          status: malformed ? "review_required" : "applied",
          revision: applied.revision,
          ...(malformed ? { reason: "legacy_safe_fallback_applied" } : {}),
        });
      }
      const selected = new Set(mapping.map((x) => x.legacy_session)),
        unselected = source
          ? Object.keys(source).filter((x) => !selected.has(x)).length
          : 0;
      const report = {
        records,
        changes,
        review_required: records.filter((x) => x.status === "review_required")
          .length,
        unselected,
      };
      await tx
        .insertInto("flag_imports")
        .values({
          tenant_id: actor.tenantId,
          id,
          user_id: actor.userId,
          project_id: project,
          source_id: sourceId,
          checksum,
          original_base64: bytes.toString("base64"),
          original_bytes: bytes.length,
          report_json: JSON.stringify(report),
          state: "applied",
          created_at: Date.now(),
        })
        .execute();
      return {
        receipt_id: id,
        state: "applied",
        replayed: false,
        records,
        review_required: report.review_required,
        unselected,
      };
    });
  }
  async original(actor: Identity, id: string) {
    const row = await this.storage.db
      .selectFrom("flag_imports")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row)
      throw new ForgeError(
        "migration_unavailable",
        "Bayrak aktarımı bulunamadı.",
        404,
      );
    await new IdentityService(this.storage.db).authorize(
      actor,
      "read",
      row.project_id,
    );
    const bytes = Buffer.from(row.original_base64, "base64");
    if (bytes.length !== row.original_bytes || hash(bytes) !== row.checksum)
      throw new ForgeError(
        "migration_corrupt",
        "Bayrak arşivi checksum doğrulanamadı.",
        409,
      );
    return bytes;
  }
  async rollback(actor: Identity, id: string) {
    return this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const row = await tx
        .selectFrom("flag_imports")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row)
        throw new ForgeError(
          "migration_unavailable",
          "Bayrak aktarımı bulunamadı.",
          404,
        );
      const identity = new IdentityService(tx),
        sessions = new SessionPreferences(identity);
      await identity.authorize(actor, "write", row.project_id);
      if (row.state === "rolled_back")
        return { receipt_id: id, state: row.state, replayed: true };
      for (const change of (
        JSON.parse(row.report_json) as { changes: Change[] }
      ).changes) {
        const current = await sessions.get(
          actor,
          row.project_id,
          change.target,
        );
        if (current.revision !== change.applied_revision)
          throw new ForgeError(
            "migration_target_changed",
            "Hedef oturum değişti; geri alma durduruldu.",
            409,
          );
        await sessions.write(
          tx,
          actor,
          row.project_id,
          change.target,
          current.revision,
          change.before,
        );
      }
      await tx
        .updateTable("flag_imports")
        .set({ state: "rolled_back" })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .execute();
      return { receipt_id: id, state: "rolled_back", replayed: false };
    });
  }
}
