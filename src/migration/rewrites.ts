import { createHash } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { DatabaseHandle } from "../storage/database.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
const hash = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
const recordSchema = z
  .object({
    ts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sessionID: z.string().min(1).max(1000),
    messageID: z.string().min(1).max(1000),
    outcome: z.literal("rewritten"),
    original: z.string().max(1024 * 1024),
    rewritten: z.string().max(1024 * 1024),
    model: z.string().max(500).nullable().optional(),
    durationMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    applied: z.boolean().optional(),
  })
  .passthrough();
export class RewriteMigration {
  constructor(readonly storage: DatabaseHandle) {}
  async import(
    actor: Identity,
    project: string,
    sourceId: string,
    checksum: string,
    bytes: Buffer,
  ) {
    if (
      bytes.length > 16 * 1024 * 1024 ||
      hash(bytes) !== checksum ||
      !/^[a-f0-9]{64}$/.test(sourceId)
    )
      throw new ForgeError(
        "source_changed",
        "Rewrite kaynağı checksum/boyut doğrulaması başarısız.",
        409,
      );
    const id = hash(
      JSON.stringify([
        actor.tenantId,
        actor.userId,
        project,
        sourceId,
        checksum,
      ]),
    );
    return this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      await new IdentityService(tx).authorize(actor, "write", project);
      const old = await tx
        .selectFrom("rewrite_imports")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (old)
        return {
          receipt_id: id,
          state: old.state,
          replayed: true,
          ...JSON.parse(old.report_json),
        };
      const total = await tx
        .selectFrom("rewrite_imports")
        .select(sql<number>`coalesce(sum(original_bytes),0)`.as("bytes"))
        .where("tenant_id", "=", actor.tenantId)
        .executeTakeFirstOrThrow();
      if (Number(total.bytes) + bytes.length > 128 * 1024 * 1024)
        throw new ForgeError(
          "migration_quota",
          "Rewrite arşivi tenant başına 128 MiB sınırını aşamaz.",
          409,
        );
      const records: {
        line: number;
        status: string;
        entry_id?: string;
        reason?: string;
      }[] = [];
      let lines: string[];
      try {
        lines = new TextDecoder("utf-8", { fatal: true })
          .decode(bytes)
          .split(/\r?\n/);
      } catch {
        lines = [];
        records.push({
          line: 0,
          status: "review_required",
          reason: "invalid_utf8",
        });
      }
      if (lines.length > 10000)
        throw new ForgeError(
          "migration_limit",
          "Rewrite dosyası 10000 satır sınırını aşıyor.",
        );
      // Insert receipt before children in the same transaction; report is finalized before commit.
      await tx
        .insertInto("rewrite_imports")
        .values({
          tenant_id: actor.tenantId,
          id,
          user_id: actor.userId,
          project_id: project,
          source_id: sourceId,
          checksum,
          original_base64: bytes.toString("base64"),
          original_bytes: bytes.length,
          report_json: "{}",
          state: "applied",
          created_at: Date.now(),
        })
        .execute();
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        let record: z.infer<typeof recordSchema>;
        try {
          record = recordSchema.parse(JSON.parse(line));
        } catch {
          records.push({
            line: index + 1,
            status: "review_required",
            reason: "malformed_record",
          });
          continue;
        }
        const entryId = hash(
          JSON.stringify([
            actor.tenantId,
            actor.userId,
            project,
            record.ts,
            record.sessionID,
            record.messageID,
            record.original,
            record.rewritten,
            record.applied ?? null,
            record.model ?? null,
            record.durationMs,
          ]),
        );
        const existing = await tx
          .selectFrom("imported_rewrites")
          .select("id")
          .where("tenant_id", "=", actor.tenantId)
          .where("id", "=", entryId)
          .executeTakeFirst();
        if (existing) {
          await tx
            .insertInto("rewrite_import_links")
            .values({
              tenant_id: actor.tenantId,
              import_id: id,
              entry_id: entryId,
            })
            .onConflict((oc) =>
              oc.columns(["tenant_id", "import_id", "entry_id"]).doNothing(),
            )
            .execute();
          records.push({
            line: index + 1,
            status: "duplicate",
            entry_id: entryId,
          });
          continue;
        }
        await tx
          .insertInto("imported_rewrites")
          .values({
            tenant_id: actor.tenantId,
            id: entryId,
            user_id: actor.userId,
            project_id: project,
            import_id: id,
            payload_json: JSON.stringify(record),
            source_ts: record.ts,
          })
          .execute();
        await tx
          .insertInto("rewrite_import_links")
          .values({
            tenant_id: actor.tenantId,
            import_id: id,
            entry_id: entryId,
          })
          .execute();
        records.push({ line: index + 1, status: "created", entry_id: entryId });
      }
      const report = {
        records,
        review_required: records.filter((x) => x.status === "review_required")
          .length,
      };
      await tx
        .updateTable("rewrite_imports")
        .set({ report_json: JSON.stringify(report) })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .execute();
      return { receipt_id: id, state: "applied", replayed: false, ...report };
    });
  }
  async list(actor: Identity, project: string, after = "") {
    if (after && !/^[a-f0-9]{64}$/.test(after))
      throw new ForgeError("invalid_cursor", "Geçmiş cursor geçersiz.");
    await new IdentityService(this.storage.db).authorize(
      actor,
      "read",
      project,
    );
    const rows = await this.storage.db
      .selectFrom("imported_rewrites")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("project_id", "=", project)
      .where("id", ">", after)
      .orderBy("id")
      .limit(21)
      .execute();
    return {
      items: rows.slice(0, 20).map((row) => {
        const p = recordSchema.parse(JSON.parse(row.payload_json));
        return {
          id: row.id,
          source_ts: row.source_ts,
          original_preview: p.original.slice(0, 400),
          rewritten_preview: p.rewritten.slice(0, 400),
          source_applied: p.applied ?? null,
          model: p.model ?? null,
          duration_ms: p.durationMs,
        };
      }),
      next: rows.length > 20 ? rows[19]!.id : null,
    };
  }
  async detail(actor: Identity, project: string, id: string) {
    await new IdentityService(this.storage.db).authorize(
      actor,
      "read",
      project,
    );
    const row = await this.storage.db
      .selectFrom("imported_rewrites")
      .select("payload_json")
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("project_id", "=", project)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row)
      throw new ForgeError(
        "rewrite_unavailable",
        "Özel rewrite kaydı bulunamadı.",
        404,
      );
    return {
      origin: "legacy_import",
      record: recordSchema.parse(JSON.parse(row.payload_json)),
    };
  }
  async original(actor: Identity, id: string) {
    const row = await this.storage.db
      .selectFrom("rewrite_imports")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row)
      throw new ForgeError(
        "migration_unavailable",
        "Rewrite aktarımı bulunamadı.",
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
        "Arşiv checksum doğrulanamadı.",
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
        .selectFrom("rewrite_imports")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row)
        throw new ForgeError(
          "migration_unavailable",
          "Rewrite aktarımı bulunamadı.",
          404,
        );
      await new IdentityService(tx).authorize(actor, "write", row.project_id);
      if (row.state === "rolled_back")
        return { receipt_id: id, state: row.state, replayed: true };
      const links = await tx
        .selectFrom("rewrite_import_links")
        .select("entry_id")
        .where("tenant_id", "=", actor.tenantId)
        .where("import_id", "=", id)
        .execute();
      await tx
        .deleteFrom("rewrite_import_links")
        .where("tenant_id", "=", actor.tenantId)
        .where("import_id", "=", id)
        .execute();
      for (const link of links) {
        const remains = await tx
          .selectFrom("rewrite_import_links")
          .select("entry_id")
          .where("tenant_id", "=", actor.tenantId)
          .where("entry_id", "=", link.entry_id)
          .executeTakeFirst();
        if (!remains)
          await tx
            .deleteFrom("imported_rewrites")
            .where("tenant_id", "=", actor.tenantId)
            .where("id", "=", link.entry_id)
            .execute();
      }
      await tx
        .updateTable("rewrite_imports")
        .set({ state: "rolled_back" })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .execute();
      return { receipt_id: id, state: "rolled_back", replayed: false };
    });
  }
}
