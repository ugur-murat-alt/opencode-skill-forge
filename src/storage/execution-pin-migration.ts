import type { Migration } from "kysely/migration";
export const executionPinMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("execution_revision_pins")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("execution_id", "text", (c) => c.notNull())
      .addColumn("skill_id", "text", (c) => c.notNull())
      .addColumn("revision", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("execution_pin_pk", [
        "tenant_id",
        "execution_id",
      ])
      .addForeignKeyConstraint(
        "execution_pin_owner",
        ["tenant_id", "execution_id"],
        "executions",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "execution_pin_revision",
        ["tenant_id", "skill_id", "revision"],
        "skill_revisions",
        ["tenant_id", "skill_id", "revision"],
      )
      .execute();
    await db.schema
      .createIndex("execution_pin_reference")
      .on("execution_revision_pins")
      .columns(["tenant_id", "skill_id", "revision"])
      .execute();
  },
};
