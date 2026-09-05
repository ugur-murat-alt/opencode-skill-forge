import type { Migration } from "kysely/migration";
export const installationMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("client_installations")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("client", "text", (c) => c.notNull())
      .addColumn("version", "text")
      .addColumn("directory", "text", (c) => c.notNull())
      .addColumn("capabilities_json", "text", (c) => c.notNull())
      .addColumn("last_seen", "bigint")
      .addColumn("last_event", "text")
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("installation_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "installation_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "installation_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .execute();
    await db.schema
      .createIndex("installation_actor")
      .on("client_installations")
      .columns(["tenant_id", "user_id", "project_id"])
      .execute();
  },
};
