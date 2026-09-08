import type { Migration } from "kysely/migration";
export const roleRegistryMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("role_registry")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("base", "text")
      .addColumn("tools_json", "text")
      .addColumn("deleted", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("role_registry_pk", ["tenant_id", "name"])
      .addForeignKeyConstraint(
        "role_registry_tenant",
        ["tenant_id"],
        "tenants",
        ["id"],
      )
      .execute();
  },
};
