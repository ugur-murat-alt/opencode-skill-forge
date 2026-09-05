import type { Migration } from "kysely/migration";
import { sql } from "kysely";
export const learningHistoryMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("learning_entries")
      .addColumn("revision", "integer", (c) => c.notNull().defaultTo(1))
      .execute();
    await db.schema
      .createTable("learning_history")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("entry_id", "text", (c) => c.notNull())
      .addColumn("revision", "integer", (c) => c.notNull())
      .addColumn("content", "text", (c) => c.notNull())
      .addColumn("trigger_text", "text", (c) => c.notNull())
      .addColumn("disabled", "integer", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("learning_history_pk", [
        "tenant_id",
        "entry_id",
        "revision",
      ])
      .addForeignKeyConstraint(
        "learning_history_entry",
        ["tenant_id", "entry_id"],
        "learning_entries",
        ["tenant_id", "id"],
        (c) => c.onDelete("cascade"),
      )
      .execute();
    await sql`insert into learning_history (tenant_id,entry_id,revision,content,trigger_text,disabled,created_at) select tenant_id,id,revision,content,trigger_text,disabled,created_at from learning_entries`.execute(
      db,
    );
  },
};
