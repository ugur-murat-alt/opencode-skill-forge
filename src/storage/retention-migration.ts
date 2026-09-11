import type { Migration } from "kysely/migration";

/**
 * Issue #41 (M08): retention, forgetting/purge and restore reconciliation.
 *
 *  - `memory_purges` is the durable forget receipt. It survives an older
 *    backup restore so newer deletion decisions can be re-applied; a restored
 *    manifest without this section requires operator reconciliation before any
 *    automatic write starts.
 *  - `memory_retention_runs` records bounded retention passes (counts only).
 *  - `memory_restore_receipts` records each restore and whether purge records
 *    travelled with it.
 *
 * Migration 038 (M06 curator) and 032–037 are not touched.
 */
export const retentionMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable("memory_purges")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("space_id", "text", (c) => c.notNull())
      .addColumn("note_id", "text", (c) => c.notNull())
      .addColumn("purged_at", "integer", (c) => c.notNull())
      .addColumn("reason", "text", (c) => c.notNull())
      .addColumn("source", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("memory_purges_pk", [
        "tenant_id",
        "space_id",
        "note_id",
      ])
      .execute();

    await db.schema
      .createTable("memory_retention_runs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("started_at", "integer", (c) => c.notNull())
      .addColumn("finished_at", "integer", (c) => c.notNull())
      .addColumn("report_json", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("memory_restore_receipts")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("backend", "text", (c) => c.notNull())
      .addColumn("manifest_created_at", "text")
      .addColumn("purges_included", "integer", (c) => c.notNull())
      .addColumn("purges_applied", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("reconciled_at", "integer")
      .addColumn("created_at", "integer", (c) => c.notNull())
      .execute();
  },
};
