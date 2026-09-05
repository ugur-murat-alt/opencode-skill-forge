import type { Migration } from "kysely/migration";
export const deletionMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("package_deletions")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("skill_id", "text", (c) => c.notNull())
      .addColumn("scope_key", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("package_deletion_pk", ["tenant_id", "skill_id"])
      .execute();
    await db.schema
      .createTable("package_gc")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("skill_id", "text", (c) => c.notNull())
      .addColumn("revision", "text", (c) => c.notNull())
      .addColumn("package_path", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("updated_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("package_gc_pk", [
        "tenant_id",
        "skill_id",
        "revision",
      ])
      .execute();
  },
};
