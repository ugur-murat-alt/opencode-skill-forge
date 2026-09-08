import type { Migration } from "kysely/migration";
export const agentPromptMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("agent_prompts")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("profile", "text", (c) => c.notNull())
      .addColumn("scope", "text", (c) => c.notNull())
      .addColumn("version", "integer", (c) => c.notNull())
      .addColumn("content", "text", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("agent_prompt_pk", [
        "tenant_id",
        "profile",
        "scope",
        "version",
      ])
      .addForeignKeyConstraint(
        "agent_prompt_tenant",
        ["tenant_id"],
        "tenants",
        ["id"],
      )
      .execute();
    await db.schema
      .createIndex("agent_prompt_lookup")
      .on("agent_prompts")
      .columns(["tenant_id", "profile", "scope", "version"])
      .execute();
  },
};
