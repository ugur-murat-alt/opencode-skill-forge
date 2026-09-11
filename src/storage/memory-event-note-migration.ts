import type { Migration } from "kysely/migration";

/**
 * Issue #35 (M02 follow-up): bind each durable event to its target note.
 *
 * Without it, a committed event whose `receipt_json` was lost could only be
 * reconstructed by `(tenant, space, revision)`, which can select a different
 * note that happens to share the same revision number. The column is
 * additive; `033_memory_pipeline` is not modified. Legacy rows keep NULL and
 * reconstruction then fails explicitly instead of guessing.
 */
export const memoryEventNoteMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("memory_events")
      .addColumn("note_id", "text")
      .execute();
  },
};
