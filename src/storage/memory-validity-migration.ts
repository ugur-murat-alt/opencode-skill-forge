import type { Migration } from "kysely/migration";

/**
 * Issue #36 (M03 follow-up): temporal validity on the derived index head.
 *
 * `valid_from`/`valid_until` mirror the accepted revision's validity window so
 * a query with an explicit `asOf` never presents a note whose window has
 * closed as current. Additive; 032–035 are not modified.
 */
export const memoryValidityMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("memory_index_heads")
      .addColumn("valid_from", "bigint")
      .execute();
    await db.schema
      .alterTable("memory_index_heads")
      .addColumn("valid_until", "bigint")
      .execute();
  },
};
