import type { Migration } from "kysely/migration";

/**
 * Issue #39 (M06) Faz A: the limited MemoryCurator surface.
 *
 *  - `memory_curator_profiles`: an explicit, independent model binding for
 *    memory work. It never shares the skill provider role and never falls
 *    back to another role or an environment credential.
 *  - `memory_curator_extractions`: one bounded extraction record per
 *    (space, source fingerprint, extractor/policy version). A successful
 *    record makes a repeated unchanged request model-free.
 *  - `memory_curator_changes`: create/update/supersede/link candidates from
 *    the internal tools. Candidates are not notes; only the policy-gated
 *    commit path turns an allowed candidate into a memory revision.
 *
 * Migration 035 is reserved for M03; 036 (M05 spool) and 032-034 are not
 * touched.
 */
export const curatorMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable("memory_curator_profiles")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("revision", "integer", (c) => c.notNull())
      .addColumn("profile_json", "text", (c) => c.notNull())
      .addColumn("secret_ref", "text")
      .addColumn("created_at", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("memory_curator_profiles_pk", [
        "tenant_id",
        "id",
      ])
      .execute();
    await db.schema
      .createIndex("memory_curator_profiles_latest_idx")
      .on("memory_curator_profiles")
      .columns(["tenant_id", "user_id", "revision"])
      .unique()
      .execute();

    await db.schema
      .createTable("memory_curator_extractions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("space_id", "text", (c) => c.notNull())
      .addColumn("run_id", "text", (c) => c.notNull())
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("extractor_version", "text", (c) => c.notNull())
      .addColumn("policy_version", "text", (c) => c.notNull())
      .addColumn("source_fingerprint", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("result_json", "text")
      .addColumn("usage_json", "text")
      .addColumn("error_code", "text")
      .addColumn("created_at", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("memory_curator_extractions_key_idx")
      .on("memory_curator_extractions")
      .columns([
        "tenant_id",
        "space_id",
        "extractor_version",
        "policy_version",
        "source_fingerprint",
      ])
      .execute();

    await db.schema
      .createTable("memory_curator_changes")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("space_id", "text", (c) => c.notNull())
      .addColumn("extraction_id", "text")
      .addColumn("run_id", "text", (c) => c.notNull())
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("operation", "text", (c) => c.notNull())
      .addColumn("note_id", "text")
      .addColumn("base_revision", "integer")
      .addColumn("kind", "text")
      .addColumn("title", "text")
      .addColumn("summary", "text")
      .addColumn("body_md", "text")
      .addColumn("rationale", "text", (c) => c.notNull())
      .addColumn("source_refs_json", "text", (c) => c.notNull())
      .addColumn("claim_class", "text")
      .addColumn("relation", "text")
      .addColumn("target_note_id", "text")
      .addColumn("confidence_micros", "integer")
      .addColumn("risk", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("applied_revision", "integer")
      .addColumn("reason", "text")
      .addColumn("created_at", "integer", (c) => c.notNull())
      .addColumn("updated_at", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("memory_curator_changes_state_idx")
      .on("memory_curator_changes")
      .columns(["tenant_id", "space_id", "state"])
      .execute();
  },
};
