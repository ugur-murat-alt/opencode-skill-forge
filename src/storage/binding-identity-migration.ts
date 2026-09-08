import type { Migration } from "kysely/migration";
export const bindingIdentityMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("project_bindings")
      .addColumn("local_name", "text")
      .execute();
    await db.schema
      .alterTable("project_bindings")
      .addColumn("fs_fingerprint", "text")
      .execute();
  },
};
