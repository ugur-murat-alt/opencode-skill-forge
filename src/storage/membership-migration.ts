import type { Migration } from "kysely/migration";
export const membershipMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("memberships")
      .addColumn("disabled", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
    await db.schema
      .alterTable("memberships")
      .addColumn("generation", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
    await db.schema
      .alterTable("project_members")
      .addColumn("generation", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
  },
};
