import type { Migration } from "kysely/migration";
export const executionMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("executions")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("idempotency_key", "text", (c) => c.notNull())
      .addColumn("input_hash", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("result_json", "text")
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("execution_pk", ["tenant_id", "id"])
      .addUniqueConstraint("execution_dedup", [
        "tenant_id",
        "user_id",
        "project_id",
        "idempotency_key",
      ])
      .addForeignKeyConstraint(
        "execution_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "execution_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .execute();
  },
};
