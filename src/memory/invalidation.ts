import type { Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import { ForgeError } from "../domain/errors.js";

/**
 * Issue #41 (M08): derived-invalidation and tombstone/purge guards shared by
 * the delete path and the commit pipeline. No primary note/revision content is
 * touched here.
 */

/** Removes only derived index rows for a note; accepted revisions stay. */
export async function invalidateDerivedForNote(
  db: Kysely<DB>,
  key: { tenant_id: string; space_id: string; note_id: string },
): Promise<void> {
  for (const table of [
    "memory_index_terms",
    "memory_index_edges",
    "memory_index_heads",
  ] as const)
    await db
      .deleteFrom(table)
      .where("tenant_id", "=", key.tenant_id)
      .where("space_id", "=", key.space_id)
      .where("note_id", "=", key.note_id)
      .execute();
}

/**
 * A commit target must not be purged or tombstoned. A purged note is never
 * revived by replay, an old spool row or a stale candidate; restore is the
 * explicit path back (and is unavailable after purge).
 */
export async function assertCommitTarget(
  db: Kysely<DB>,
  key: { tenantId: string; spaceId: string; noteId: string },
): Promise<void> {
  const purged = await db
    .selectFrom("memory_purges")
    .select(["note_id"])
    .where("tenant_id", "=", key.tenantId)
    .where("space_id", "=", key.spaceId)
    .where("note_id", "=", key.noteId)
    .executeTakeFirst();
  if (purged)
    throw new ForgeError(
      "memory_note_purged",
      "Bu not açıkça unutuldu; replay onu diriltemez.",
      409,
    );
  const note = await db
    .selectFrom("memory_notes")
    .select(["deleted_at"])
    .where("tenant_id", "=", key.tenantId)
    .where("space_id", "=", key.spaceId)
    .where("id", "=", key.noteId)
    .executeTakeFirst();
  if (note && note.deleted_at !== null)
    throw new ForgeError(
      "memory_note_unavailable",
      "Not silinmiş durumda; önce açık restore gerekir.",
      409,
    );
}
