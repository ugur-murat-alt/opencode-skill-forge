import type { Migration } from "kysely/migration";

/**
 * Issue #41 (M08) follow-up: PostgreSQL int4 timestamp overflow.
 *
 * Migration 039 declared `purged_at`, `started_at`, `finished_at`,
 * `reconciled_at` and `created_at` as `integer`. SQLite stores 64-bit
 * integer values either way, but PostgreSQL rejects millisecond epochs with
 * `22003 out of range`. This migration converts exactly those columns to
 * bigint on PostgreSQL; on SQLite it is a no-op because its INTEGER affinity
 * is already a signed 64-bit value (and the driver would reject a type change
 * that is not needed). 039 is intentionally not edited.
 *
 * The purge cleanup columns (`file_paths_json`, `cleanup_pending`,
 * `cleanup_attempts`, `cleanup_next_at`) are added on both backends: a purge
 * receipt stays durable and retryable when a revision file cannot be removed
 * after the transaction committed.
 */
export function retentionBigintMigration(
  backend: "sqlite" | "postgres",
): Migration {
  return {
    async up(db) {
      await db.schema
        .alterTable("memory_purges")
        .addColumn("file_paths_json", "text")
        .execute();
      await db.schema
        .alterTable("memory_purges")
        .addColumn("cleanup_pending", "integer", (c) =>
          c.notNull().defaultTo(0),
        )
        .execute();
      await db.schema
        .alterTable("memory_purges")
        .addColumn("cleanup_attempts", "integer", (c) =>
          c.notNull().defaultTo(0),
        )
        .execute();
      await db.schema
        .alterTable("memory_purges")
        .addColumn("cleanup_next_at", "bigint", (c) => c.notNull().defaultTo(0))
        .execute();
      if (backend !== "postgres") return; // SQLite INTEGER is already 64-bit.
      for (const [table, column] of [
        ["memory_purges", "purged_at"],
        ["memory_purges", "cleanup_next_at"],
        ["memory_retention_runs", "started_at"],
        ["memory_retention_runs", "finished_at"],
        ["memory_restore_receipts", "reconciled_at"],
        ["memory_restore_receipts", "created_at"],
        ["memory_spool", "observed_at"],
        ["memory_spool", "created_at"],
        ["memory_spool", "updated_at"],
        ["memory_spool", "next_attempt_at"],
        ["memory_turn_flags", "created_at"],
        ["memory_turn_flags", "expires_at"],
        ["memory_spool_counters", "updated_at"],
        ["memory_curator_profiles", "created_at"],
        ["memory_curator_extractions", "created_at"],
        ["memory_curator_changes", "created_at"],
        ["memory_curator_changes", "updated_at"],
      ] as const)
        await db.schema
          .alterTable(table)
          .alterColumn(column, (c) => c.setDataType("bigint"))
          .execute();
    },
  };
}
