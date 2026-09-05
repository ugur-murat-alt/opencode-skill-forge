import type { Migration } from "kysely/migration";
export const learningMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("learning_entries")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("scope_key", "text", (c) => c.notNull())
      .addColumn("content", "text", (c) => c.notNull())
      .addColumn("content_hash", "text", (c) => c.notNull())
      .addColumn("trigger_text", "text", (c) => c.notNull())
      .addColumn("run_id", "text")
      .addColumn("disabled", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("learning_pk", ["tenant_id", "id"])
      .addUniqueConstraint("learning_dedup", [
        "tenant_id",
        "user_id",
        "scope_key",
        "content_hash",
      ])
      .addForeignKeyConstraint(
        "learning_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "learning_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "learning_run",
        ["tenant_id", "run_id"],
        "runs",
        ["tenant_id", "id"],
      )
      .execute();
    await db.schema
      .createIndex("learning_scope")
      .on("learning_entries")
      .columns(["tenant_id", "user_id", "scope_key", "disabled", "created_at"])
      .execute();
  },
};
