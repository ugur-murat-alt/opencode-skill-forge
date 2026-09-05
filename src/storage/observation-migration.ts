import type { Migration } from "kysely/migration";
export const observationMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("skill_observations")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("skill_id", "text", (c) => c.notNull())
      .addColumn("revision", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("correlation", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("observation_pk", ["tenant_id", "id"])
      .addUniqueConstraint("observation_delivery", [
        "tenant_id",
        "user_id",
        "project_id",
        "skill_id",
        "kind",
        "correlation",
      ])
      .addForeignKeyConstraint(
        "observation_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "observation_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "observation_revision",
        ["tenant_id", "skill_id", "revision"],
        "skill_revisions",
        ["tenant_id", "skill_id", "revision"],
      )
      .execute();
    await db.schema
      .createIndex("observation_window")
      .on("skill_observations")
      .columns(["tenant_id", "user_id", "project_id", "skill_id", "created_at"])
      .execute();
    await db.schema
      .createTable("maintenance_items")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("operation_id", "text", (c) => c.notNull())
      .addColumn("skill_id", "text", (c) => c.notNull())
      .addColumn("input_hash", "text", (c) => c.notNull())
      .addColumn("result_json", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("maintenance_item_pk", [
        "tenant_id",
        "user_id",
        "project_id",
        "operation_id",
        "skill_id",
      ])
      .addForeignKeyConstraint(
        "maintenance_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "maintenance_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .execute();
  },
};
