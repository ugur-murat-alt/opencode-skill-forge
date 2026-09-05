import type { Migration } from "kysely/migration";
export const flagImportMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("flag_imports")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("source_id", "text", (c) => c.notNull())
      .addColumn("checksum", "text", (c) => c.notNull())
      .addColumn("original_base64", "text", (c) => c.notNull())
      .addColumn("original_bytes", "integer", (c) => c.notNull())
      .addColumn("report_json", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("flag_import_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "flag_import_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "flag_import_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .execute();
  },
};
