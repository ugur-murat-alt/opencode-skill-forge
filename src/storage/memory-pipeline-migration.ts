import type { Migration } from "kysely/migration";

/**
 * Issue #35 (M02): durable Markdown pipeline tables.
 *
 * - `memory_notes` learns its source binding (id/path/hash/state) and a
 *   tombstone (`deleted_at`); deleting a source is a source state, never an
 *   automatic note delete.
 * - `memory_note_revisions` learns the immutable file location
 *   (`file_path`), the canonical `content_hash` and `byte_size`.
 * - `memory_events` learns `error_code`, the persisted `receipt_json`,
 *   `attempts` and the `indexed_at` marker (M03 fills real derived views).
 * - `memory_sources` registers user roots (read_only|managed) with a
 *   cursor/checkpoint; `memory_change_candidates` makes every observed
 *   difference or conflict visible instead of swallowing it.
 *
 * 032 is extended in place (additive columns + new tables); it is never
 * rewritten. Both backends use plain ALTER TABLE ADD COLUMN, so no table
 * rebuild is needed and foreign keys stay intact.
 */
export const memoryPipelineMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("memory_notes")
      .addColumn("source_id", "text")
      .execute();
    await db.schema
      .alterTable("memory_notes")
      .addColumn("source_path", "text")
      .execute();
    await db.schema
      .alterTable("memory_notes")
      .addColumn("source_hash", "text")
      .execute();
    await db.schema
      .alterTable("memory_notes")
      .addColumn("source_state", "text", (c) =>
        c.notNull().defaultTo("present"),
      )
      .execute();
    await db.schema
      .alterTable("memory_notes")
      .addColumn("deleted_at", "bigint")
      .execute();
    await db.schema
      .alterTable("memory_note_revisions")
      .addColumn("file_path", "text")
      .execute();
    await db.schema
      .alterTable("memory_note_revisions")
      .addColumn("content_hash", "text")
      .execute();
    await db.schema
      .alterTable("memory_note_revisions")
      .addColumn("byte_size", "integer")
      .execute();
    await db.schema
      .alterTable("memory_events")
      .addColumn("error_code", "text")
      .execute();
    await db.schema
      .alterTable("memory_events")
      .addColumn("receipt_json", "text")
      .execute();
    await db.schema
      .alterTable("memory_events")
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
    await db.schema
      .alterTable("memory_events")
      .addColumn("indexed_at", "bigint")
      .execute();

    await db.schema
      .createTable("memory_sources")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("space_id", "text", (c) => c.notNull())
      .addColumn("root_path", "text", (c) => c.notNull())
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("cursor_json", "text")
      .addColumn("checkpoint", "text")
      .addColumn("last_scan_at", "bigint")
      .addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addColumn("updated_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("memory_source_pk", ["tenant_id", "id"])
      .addUniqueConstraint("memory_source_root", [
        "tenant_id",
        "space_id",
        "root_path",
      ])
      .addForeignKeyConstraint(
        "memory_source_space",
        ["tenant_id", "space_id"],
        "memory_spaces",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "memory_source_creator",
        ["tenant_id", "created_by"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .execute();
    await db.schema
      .createIndex("memory_source_space")
      .on("memory_sources")
      .columns(["tenant_id", "space_id", "status"])
      .execute();

    await db.schema
      .createTable("memory_change_candidates")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("source_id", "text")
      .addColumn("path", "text", (c) => c.notNull())
      .addColumn("note_id", "text")
      .addColumn("previous_hash", "text")
      .addColumn("observed_hash", "text")
      .addColumn("base_revision", "integer")
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("reason", "text")
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addColumn("updated_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("memory_candidate_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "memory_candidate_source",
        ["tenant_id", "source_id"],
        "memory_sources",
        ["tenant_id", "id"],
      )
      .execute();
    await db.schema
      .createIndex("memory_candidate_state")
      .on("memory_change_candidates")
      .columns(["tenant_id", "state", "created_at"])
      .execute();
    await db.schema
      .createIndex("memory_candidate_source_path")
      .on("memory_change_candidates")
      .columns(["tenant_id", "source_id", "path"])
      .execute();
  },
};
