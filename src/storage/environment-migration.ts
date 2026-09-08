import { randomUUID } from "node:crypto";
import type { Migration } from "kysely/migration";
export const environmentMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("environments")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("environment_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint("environment_tenant", ["tenant_id"], "tenants", [
        "id",
      ])
      .execute();
    await db.schema
      .alterTable("projects")
      .addColumn("environment_id", "text")
      .execute();
    const tenants = await db.selectFrom("tenants").select("id").execute();
    for (const tenant of tenants) {
      const id = randomUUID();
      await db
        .insertInto("environments")
        .values({
          tenant_id: tenant.id,
          id,
          name: "default",
          created_at: Date.now(),
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();
      await db
        .updateTable("projects")
        .set({ environment_id: id })
        .where("tenant_id", "=", tenant.id)
        .where("environment_id", "is", null)
        .execute();
    }
  },
};
