import type { Migration } from "kysely/migration";
export const orgLifecycleMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("tenant_lifecycle")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("frozen", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("deletion_requested_at", "bigint")
      .addColumn("deletion_requested_by", "text")
      .addPrimaryKeyConstraint("tenant_lifecycle_pk", ["tenant_id"])
      .addForeignKeyConstraint(
        "tenant_lifecycle_tenant",
        ["tenant_id"],
        "tenants",
        ["id"],
      )
      .execute();
    await db.schema
      .createTable("transfer_offers")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("to_user_id", "text", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("expires_at", "bigint", (c) => c.notNull())
      .addColumn("accepted_at", "bigint")
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("transfer_offer_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "transfer_offer_tenant",
        ["tenant_id"],
        "tenants",
        ["id"],
      )
      .execute();
  },
};
