import type { Migration } from "kysely/migration";
export const rewriteImportMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("rewrite_imports")
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
      .addPrimaryKeyConstraint("rewrite_import_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "rewrite_import_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "rewrite_import_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .execute();
    await db.schema
      .createTable("imported_rewrites")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("import_id", "text", (c) => c.notNull())
      .addColumn("payload_json", "text", (c) => c.notNull())
      .addColumn("source_ts", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("imported_rewrite_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "imported_rewrite_import",
        ["tenant_id", "import_id"],
        "rewrite_imports",
        ["tenant_id", "id"],
      )
      .execute();
    await db.schema
      .createTable("rewrite_import_links")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("import_id", "text", (c) => c.notNull())
      .addColumn("entry_id", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("rewrite_link_pk", [
        "tenant_id",
        "import_id",
        "entry_id",
      ])
      .addForeignKeyConstraint(
        "rewrite_link_import",
        ["tenant_id", "import_id"],
        "rewrite_imports",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "rewrite_link_entry",
        ["tenant_id", "entry_id"],
        "imported_rewrites",
        ["tenant_id", "id"],
      )
      .execute();
    await db.schema
      .createIndex("imported_rewrite_owner")
      .on("imported_rewrites")
      .columns(["tenant_id", "user_id", "project_id", "id"])
      .execute();
  },
};
