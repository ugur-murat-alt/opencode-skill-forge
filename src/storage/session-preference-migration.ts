import type { Migration } from "kysely/migration";
export const sessionPreferenceMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("session_preferences")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("session_key", "text", (c) => c.notNull())
      .addColumn("revision", "integer", (c) => c.notNull())
      .addColumn("payload", "text", (c) => c.notNull())
      .addColumn("updated_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("session_preference_pk", [
        "tenant_id",
        "user_id",
        "project_id",
        "session_key",
      ])
      .addForeignKeyConstraint(
        "session_preference_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "session_preference_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .execute();
  },
};
