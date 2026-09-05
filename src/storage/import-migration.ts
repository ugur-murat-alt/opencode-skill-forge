import type { Migration } from "kysely/migration";
export const importMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("migration_receipts")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("source_id", "text", (c) => c.notNull())
      .addColumn("source_checksum", "text", (c) => c.notNull())
      .addColumn("skill_id", "text", (c) => c.notNull())
      .addColumn("revision", "text", (c) => c.notNull())
      .addColumn("skill_generation", "bigint", (c) => c.notNull())
      .addColumn("flags_json", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addColumn("updated_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("migration_receipt_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "migration_receipt_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "migration_receipt_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "migration_receipt_revision",
        ["tenant_id", "skill_id", "revision"],
        "skill_revisions",
        ["tenant_id", "skill_id", "revision"],
      )
      .execute();
  },
};
