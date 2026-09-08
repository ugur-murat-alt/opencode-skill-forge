import type { Migration } from "kysely/migration";
export const inviteMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("invitations")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("token_hash", "text", (c) => c.notNull().unique())
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("invited_by", "text", (c) => c.notNull())
      .addColumn("expires_at", "bigint", (c) => c.notNull())
      .addColumn("accepted_at", "bigint")
      .addColumn("revoked", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("invitation_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint("invitation_tenant", ["tenant_id"], "tenants", [
        "id",
      ])
      .execute();
    await db.schema
      .createIndex("invitation_expiry")
      .on("invitations")
      .columns(["tenant_id", "revoked", "expires_at"])
      .execute();
  },
};
