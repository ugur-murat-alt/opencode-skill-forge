import type { Migration } from "kysely/migration";
export const runPinMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("run_revision_pins")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("run_id", "text", (c) => c.notNull())
      .addColumn("fence", "integer", (c) => c.notNull())
      .addColumn("skill_id", "text", (c) => c.notNull())
      .addColumn("revision", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("run_pin_pk", ["tenant_id", "run_id", "fence"])
      .addForeignKeyConstraint(
        "run_pin_owner",
        ["tenant_id", "run_id"],
        "runs",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "run_pin_revision",
        ["tenant_id", "skill_id", "revision"],
        "skill_revisions",
        ["tenant_id", "skill_id", "revision"],
      )
      .execute();
    await db.schema
      .createIndex("run_pin_reference")
      .on("run_revision_pins")
      .columns(["tenant_id", "skill_id", "revision"])
      .execute();
  },
};
