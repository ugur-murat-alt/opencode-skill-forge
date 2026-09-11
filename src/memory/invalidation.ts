import { sql, type Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import { ForgeError } from "../domain/errors.js";
import { resolveVaultRelative } from "./paths.js";
import { unlink } from "node:fs/promises";

/**
 * Issue #41 (M08): derived-invalidation and tombstone/purge guards shared by
 * the delete path and the commit pipeline. No primary note/revision content is
 * touched here.
 *
 * `memory_index_edges` has no `note_id` column: a note participates as either
 * the source or the target of an edge. SQLite silently treats an unknown
 * double-quoted identifier as a string constant, so using `note_id` there
 * deletes nothing and PostgreSQL fails with 42703; both are covered by tests.
 */

/** Removes only derived index rows for a note; accepted revisions stay. */
export async function invalidateDerivedForNote(
  db: Kysely<DB>,
  key: { tenant_id: string; space_id: string; note_id: string },
): Promise<void> {
  await db
    .deleteFrom("memory_index_terms")
    .where("tenant_id", "=", key.tenant_id)
    .where("space_id", "=", key.space_id)
    .where("note_id", "=", key.note_id)
    .execute();
  await db
    .deleteFrom("memory_index_heads")
    .where("tenant_id", "=", key.tenant_id)
    .where("space_id", "=", key.space_id)
    .where("note_id", "=", key.note_id)
    .execute();
  await db
    .deleteFrom("memory_index_edges")
    .where("tenant_id", "=", key.tenant_id)
    .where("space_id", "=", key.space_id)
    .where((eb) =>
      eb.or([
        eb("source_note_id", "=", key.note_id),
        eb("target_note_id", "=", key.note_id),
      ]),
    )
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
      "memory_note_deleted",
      "Not arşivlenmiş/silinmiş; önce açık restore gerekir.",
      409,
    );
}

export const MAX_PURGE_CLEANUP_PER_RUN = 100;

/**
 * Bounded, retryable cleanup of revision files for already-committed purges.
 * A purge is durable before any file is touched; a failed unlink leaves the
 * receipt with `cleanup_pending = 1` and is retried with backoff, so a
 * "note row present but file missing" state cannot occur.
 */
export async function cleanupPendingPurgeFiles(
  db: Kysely<DB>,
  vaultRoot: string | undefined,
  now: number,
): Promise<{
  cleaned: number;
  failed: number;
  pending: number;
  /** Actually unlinked files per `${tenant}\u0000${space}\u0000${note}`. */
  unlinkedByNote: Map<string, number>;
}> {
  if (!vaultRoot)
    return {
      cleaned: 0,
      failed: 0,
      pending: await pendingPurgeCount(db),
      unlinkedByNote: new Map(),
    };
  const rows = await db
    .selectFrom("memory_purges")
    .select([
      "tenant_id",
      "space_id",
      "note_id",
      "file_paths_json",
      "cleanup_attempts",
    ])
    .where("cleanup_pending", "=", 1)
    .where("cleanup_next_at", "<=", now)
    .orderBy("cleanup_next_at")
    .limit(MAX_PURGE_CLEANUP_PER_RUN)
    .execute();
  let cleaned = 0,
    failed = 0;
  const unlinkedByNote = new Map<string, number>();
  for (const row of rows) {
    const paths = parseFilePaths(row.file_paths_json);
    let ok = true;
    let unlinked = 0;
    for (const path of paths) {
      try {
        await unlink(resolveVaultRelative(vaultRoot, path));
        unlinked += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") ok = false;
      }
    }
    unlinkedByNote.set(
      `${row.tenant_id}\u0000${row.space_id}\u0000${row.note_id}`,
      unlinked,
    );
    if (ok) {
      await db
        .updateTable("memory_purges")
        .set({ cleanup_pending: 0, cleanup_next_at: 0 })
        .where("tenant_id", "=", row.tenant_id)
        .where("space_id", "=", row.space_id)
        .where("note_id", "=", row.note_id)
        .execute();
      cleaned += 1;
    } else {
      const attempts = Number(row.cleanup_attempts) + 1;
      await db
        .updateTable("memory_purges")
        .set({
          cleanup_attempts: attempts,
          cleanup_next_at: now + Math.min(1000 * 2 ** attempts, 60 * 60 * 1000),
        })
        .where("tenant_id", "=", row.tenant_id)
        .where("space_id", "=", row.space_id)
        .where("note_id", "=", row.note_id)
        .execute();
      failed += 1;
    }
  }
  return {
    cleaned,
    failed,
    pending: await pendingPurgeCount(db),
    unlinkedByNote,
  };
}

export async function pendingPurgeCount(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("memory_purges")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("cleanup_pending", "=", 1)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

function parseFilePaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 1000)
      : [];
  } catch {
    return [];
  }
}

export { sql };
