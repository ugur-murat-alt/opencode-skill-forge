import type { Migration } from "kysely/migration";
export const readerMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("revision_readers")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("skill_id", "text", (c) => c.notNull())
      .addColumn("revision", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("revision_reader_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "revision_reader_target",
        ["tenant_id", "skill_id", "revision"],
        "skill_revisions",
        ["tenant_id", "skill_id", "revision"],
      )
      .execute();
    await db.schema
      .createIndex("revision_reader_reference")
      .on("revision_readers")
      .columns(["tenant_id", "skill_id", "revision"])
      .execute();
  },
};
