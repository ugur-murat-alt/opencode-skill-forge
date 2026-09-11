import type { Migration } from "kysely/migration";

/**
 * Issue #38 (M05) Faz A: the local durable hook spool.
 *
 * The spool is a delivery buffer between the client hook process and the M02
 * ingest pipeline. It is not a second primary record: the accepted note
 * revision lives in the memory pipeline after `/api/memory/ingest` commits it.
 *
 * The local SQLite file (`dataDir/local.sqlite`) is used even when the service
 * profile stores its primary data in PostgreSQL, so hook capture keeps working
 * while the daemon/network is unavailable. Pending rows are never deleted
 * silently; terminal rows are retained (payload cleared) for diagnostics.
 *
 * Migration numbering: 035 is reserved for M03; 032–034 are not touched.
 */
export const memorySpoolMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable("memory_spool")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("installation_id", "text", (c) => c.notNull())
      .addColumn("project_ref", "text", (c) => c.notNull())
      .addColumn("client", "text", (c) => c.notNull())
      .addColumn("event", "text", (c) => c.notNull())
      .addColumn("session_id", "text", (c) => c.notNull())
      .addColumn("turn_ref", "text")
      .addColumn("worktree_key", "text")
      .addColumn("event_id", "text", (c) => c.notNull())
      .addColumn("source_kind", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("content", "text", (c) => c.notNull())
      .addColumn("content_hash", "text", (c) => c.notNull())
      .addColumn("content_bytes", "integer", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("next_attempt_at", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("run_id", "text")
      .addColumn("last_error", "text")
      .addColumn("observed_at", "integer", (c) => c.notNull())
      .addColumn("created_at", "integer", (c) => c.notNull())
      .addColumn("updated_at", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("memory_spool_event_unique")
      .on("memory_spool")
      .columns(["installation_id", "event_id"])
      .unique()
      .execute();
    await db.schema
      .createIndex("memory_spool_pending_idx")
      .on("memory_spool")
      .columns(["state", "next_attempt_at"])
      .execute();

    await db.schema
      .createTable("memory_turn_flags")
      .addColumn("installation_id", "text", (c) => c.notNull())
      .addColumn("session_id", "text", (c) => c.notNull())
      .addColumn("turn_ref", "text")
      .addColumn("memory_off", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "integer", (c) => c.notNull())
      .addColumn("expires_at", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("memory_turn_flags_pk", [
        "installation_id",
        "session_id",
      ])
      .execute();

    await db.schema
      .createTable("memory_spool_counters")
      .addColumn("key", "text", (c) => c.primaryKey())
      .addColumn("value", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("updated_at", "integer", (c) => c.notNull())
      .execute();
  },
};
