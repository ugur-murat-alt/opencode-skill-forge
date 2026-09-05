import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DatabaseHandle } from "../storage/database.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { LearningStore } from "../prompt/learning.js";
import { searchText } from "../skills/store.js";
import { ForgeError } from "../domain/errors.js";
const hash = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
type RecordResult = {
  index: number;
  status: "created" | "duplicate" | "review_required";
  entry_id?: string;
  reason?: string;
};
export function parseLegacyLessons(bytes: Buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    matches = [...text.matchAll(/^## \[(\d{10,13})\][ \t]*\r?$/gm)];
  if (matches.length > 10000)
    throw new ForgeError("learning_import_limit", "Ders sayısı sınırı aşıldı.");
  const prefix = text.slice(0, matches[0]?.index ?? text.length).trim();
  const malformed =
    prefix !== "# Prompt Editor — Learn" ||
    (!matches.length && prefix !== text.trim())
      ? 1
      : 0;
  return {
    malformed,
    lessons: matches.map((match, index) => ({
      ts: Number(match[1]),
      content: text
        .slice(
          match.index! + match[0].length,
          matches[index + 1]?.index ?? text.length,
        )
        .trim(),
    })),
  };
}
export class LearningMigration {
  constructor(readonly storage: DatabaseHandle) {}
  async import(
    actor: Identity,
    project: string,
    sourceId: string,
    checksum: string,
    bytes: Buffer,
    enabled: boolean,
  ) {
    if (
      bytes.length > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(sourceId) ||
      hash(bytes) !== checksum
    )
      throw new ForgeError(
        "source_changed",
        "Öğrenme kaynağı checksum/boyut doğrulaması başarısız.",
        409,
      );
    const id = hash(
      JSON.stringify([
        actor.tenantId,
        actor.userId,
        project,
        sourceId,
        checksum,
        enabled,
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
        .selectFrom("learning_imports")
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
        .selectFrom("learning_imports")
        .select(sql<number>`coalesce(sum(original_bytes),0)`.as("bytes"))
        .where("tenant_id", "=", actor.tenantId)
        .executeTakeFirstOrThrow();
      if (Number(total.bytes) + bytes.length > 128 * 1024 * 1024)
        throw new ForgeError(
          "migration_quota",
          "Özel geçiş arşivi 128 MiB tenant sınırını aşamaz.",
          409,
        );
      let parsed: ReturnType<typeof parseLegacyLessons>;
      try {
        parsed = parseLegacyLessons(bytes);
      } catch {
        parsed = { malformed: 1, lessons: [] };
      }
      const results: RecordResult[] = [],
        scope = `personal:${actor.userId}`,
        learning = new LearningStore(this.storage);
      const count = await tx
        .selectFrom("learning_entries")
        .select(sql<number>`count(*)`.as("n"))
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("scope_key", "=", scope)
        .executeTakeFirstOrThrow();
      let remaining = 200 - Number(count.n);
      for (const [index, lesson] of parsed.lessons.entries()) {
        const triggers = [
          ...new Set(
            searchText(lesson.content)
              .split(/[^\p{L}\p{N}]+/u)
              .filter((x) => x.length > 2),
          ),
        ]
          .join(" ")
          .slice(0, 200);
        try {
          learning.validate({ content: lesson.content, triggers });
        } catch {
          results.push({
            index,
            status: "review_required",
            reason: "learning_not_reusable",
          });
          continue;
        }
        const contentHash = hash(lesson.content),
          duplicate = await tx
            .selectFrom("learning_entries")
            .select("id")
            .where("tenant_id", "=", actor.tenantId)
            .where("user_id", "=", actor.userId)
            .where("scope_key", "=", scope)
            .where("content_hash", "=", contentHash)
            .executeTakeFirst();
        if (duplicate) {
          results.push({ index, status: "duplicate", entry_id: duplicate.id });
          continue;
        }
        if (remaining <= 0) {
          results.push({
            index,
            status: "review_required",
            reason: "learning_capacity",
          });
          continue;
        }
        const entryId = randomUUID(),
          now = Date.now();
        await tx
          .insertInto("learning_entries")
          .values({
            tenant_id: actor.tenantId,
            id: entryId,
            user_id: actor.userId,
            project_id: project,
            scope_key: scope,
            content: lesson.content,
            content_hash: contentHash,
            trigger_text: triggers,
            run_id: null,
            disabled: enabled ? 0 : 1,
            revision: 1,
            created_at: now,
          })
          .execute();
        await tx
          .insertInto("learning_history")
          .values({
            tenant_id: actor.tenantId,
            entry_id: entryId,
            revision: 1,
            content: lesson.content,
            trigger_text: triggers,
            disabled: enabled ? 0 : 1,
            created_at: now,
          })
          .execute();
        remaining--;
        results.push({ index, status: "created", entry_id: entryId });
      }
      const report = {
        records: results,
        review_required:
          parsed.malformed +
          results.filter((x) => x.status === "review_required").length,
        malformed: parsed.malformed,
      };
      await tx
        .insertInto("learning_imports")
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
      return { receipt_id: id, state: "applied", replayed: false, ...report };
    });
  }
  async original(actor: Identity, id: string) {
    const row = await this.storage.db
      .selectFrom("learning_imports")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row)
      throw new ForgeError(
        "migration_unavailable",
        "Öğrenme aktarımı bulunamadı.",
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
        "Özgün aktarım kaydı checksum doğrulamasından geçmedi.",
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
        .selectFrom("learning_imports")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row)
        throw new ForgeError(
          "migration_unavailable",
          "Öğrenme aktarımı bulunamadı.",
          404,
        );
      await new IdentityService(tx).authorize(actor, "write", row.project_id);
      if (row.state === "rolled_back")
        return { receipt_id: id, state: row.state, replayed: true };
      const report = JSON.parse(row.report_json) as { records: RecordResult[] };
      const createdIds = new Set(
        report.records
          .filter((record) => record.status === "created")
          .map((record) => record.entry_id),
      );
      // Personal lessons can be referenced by imports in another project.
      // Hold the tenant write lock throughout this check and the deletion.
      let cursor = "";
      while (createdIds.size) {
        const receipts = await tx
          .selectFrom("learning_imports")
          .select(["id", "report_json"])
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .where("state", "=", "applied")
          .where("id", "!=", id)
          .where("id", ">", cursor)
          .orderBy("id")
          .limit(25)
          .execute();
        for (const receipt of receipts) {
          const references = JSON.parse(receipt.report_json) as {
            records: RecordResult[];
          };
          if (
            references.records.some(
              (record) => record.entry_id && createdIds.has(record.entry_id),
            )
          )
            throw new ForgeError(
              "migration_target_referenced",
              "Ders başka etkin aktarımda kullanılıyor; önce bağımlı aktarımı geri alın.",
              409,
            );
        }
        if (receipts.length < 25) break;
        cursor = receipts.at(-1)!.id;
      }
      for (const record of report.records.filter(
        (x) => x.status === "created",
      )) {
        const entry = await tx
          .selectFrom("learning_entries")
          .select("revision")
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .where("id", "=", record.entry_id!)
          .executeTakeFirst();
        if (entry && entry.revision !== 1)
          throw new ForgeError(
            "migration_target_changed",
            "Aktarılan ders değişti; geri alma durduruldu.",
            409,
          );
        await tx
          .deleteFrom("learning_entries")
          .where("tenant_id", "=", actor.tenantId)
          .where("user_id", "=", actor.userId)
          .where("id", "=", record.entry_id!)
          .execute();
      }
      await tx
        .updateTable("learning_imports")
        .set({ state: "rolled_back" })
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", id)
        .execute();
      return { receipt_id: id, state: "rolled_back", replayed: false };
    });
  }
}
