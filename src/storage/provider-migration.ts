import type { Migration } from "kysely/migration";
export const providerMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("provider_profiles")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("revision", "integer", (c) => c.notNull())
      .addColumn("profile_json", "text", (c) => c.notNull())
      .addColumn("secret_ref", "text")
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("provider_profile_pk", ["tenant_id", "id"])
      .addUniqueConstraint("provider_revision", [
        "tenant_id",
        "user_id",
        "role",
        "revision",
      ])
      .addForeignKeyConstraint(
        "provider_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .execute();
  },
};
