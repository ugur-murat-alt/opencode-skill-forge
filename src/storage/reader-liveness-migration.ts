import type { Migration } from "kysely/migration";
/** Issue #12: verifiable reader ownership/liveness so a crashed process or a
 * one-shot failed cleanup can no longer permanently block deletion. */
export const readerLivenessMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("revision_readers")
      .addColumn("owner", "text")
      .execute();
    await db.schema
      .alterTable("revision_readers")
      .addColumn("expires_at", "bigint")
      .execute();
  },
};
