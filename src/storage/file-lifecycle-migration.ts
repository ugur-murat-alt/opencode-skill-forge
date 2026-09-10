import type { Migration } from "kysely/migration";
/** Issue #27/#28: okuma pini sınıflandırması, publish/reclaim sahipliği ve
 * kararlı tarama imleci için kalıcı koordinasyon kayıtları. */
export const fileLifecycleMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("revision_readers")
      .addColumn("kind", "text", (c) => c.notNull().defaultTo("backup"))
      .execute();
    await db.schema
      .createTable("package_claims")
      .addColumn("tenant_id", "text", (c) =>
        c.notNull().references("tenants.id").onDelete("cascade"),
      )
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("claim_key", "text", (c) => c.notNull())
      .addColumn("owner", "text", (c) => c.notNull())
      .addColumn("expires_at", "bigint", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("package_claim_pk", [
        "tenant_id",
        "kind",
        "claim_key",
      ])
      .execute();
    await db.schema
      .createIndex("package_claim_owner")
      .on("package_claims")
      .columns(["tenant_id", "owner"])
      .execute();
    await db.schema
      .createTable("package_scan_state")
      .addColumn("tenant_id", "text", (c) =>
        c.primaryKey().references("tenants.id").onDelete("cascade"),
      )
      .addColumn("staging_cursor", "text", (c) => c.notNull().defaultTo(""))
      .addColumn("packages_cursor", "text", (c) => c.notNull().defaultTo(""))
      .addColumn("updated_at", "bigint", (c) => c.notNull())
      .execute();
  },
};
