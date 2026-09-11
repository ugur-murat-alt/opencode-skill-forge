import type { Migration } from "kysely/migration";

/**
 * Issue #36 (M03): derived search/graph index.
 *
 * Every row is bound to an accepted `note_id`/`revision`/`content_hash`. The
 * index is fully rebuildable from `memory_note_revisions` (+ revision files
 * when semantic metadata is missing); rebuild only replaces these derived
 * tables and never touches notes, ACL, events or queue history. A portable
 * term table is used instead of backend-specific FTS/tsvector so SQLite and
 * PostgreSQL produce identical scoring semantics; both lookups are indexed
 * (`tenant_id, term`) and candidate discovery is global, never "first N ids".
 * 032–034 are not modified.
 */
export const memoryIndexMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("memory_index_terms")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("space_id", "text", (c) => c.notNull())
      .addColumn("note_id", "text", (c) => c.notNull())
      .addColumn("revision", "integer", (c) => c.notNull())
      .addColumn("content_hash", "text", (c) => c.notNull())
      .addColumn("term", "text", (c) => c.notNull())
      .addColumn("field", "text", (c) => c.notNull())
      .addColumn("frequency", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("memory_index_term_pk", [
        "tenant_id",
        "space_id",
        "note_id",
        "revision",
        "term",
        "field",
      ])
      .execute();
    await db.schema
      .createIndex("memory_index_term_lookup")
      .on("memory_index_terms")
      .columns(["tenant_id", "term"])
      .execute();
    await db.schema
      .createIndex("memory_index_term_note")
      .on("memory_index_terms")
      .columns(["tenant_id", "space_id", "note_id", "revision"])
      .execute();

    await db.schema
      .createTable("memory_index_heads")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("space_id", "text", (c) => c.notNull())
      .addColumn("note_id", "text", (c) => c.notNull())
      .addColumn("revision", "integer", (c) => c.notNull())
      .addColumn("content_hash", "text", (c) => c.notNull())
      .addColumn("record_hash", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("summary", "text")
      .addColumn("lifecycle", "text", (c) => c.notNull().defaultTo("active"))
      .addColumn("pinned", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("task_status", "text")
      .addColumn("verification", "text", (c) =>
        c.notNull().defaultTo("declared"),
      )
      .addColumn("sources_json", "text", (c) => c.notNull())
      .addColumn("edges_json", "text", (c) => c.notNull())
      .addColumn("indexed_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("memory_index_head_pk", [
        "tenant_id",
        "space_id",
        "note_id",
      ])
      .execute();
    await db.schema
      .createIndex("memory_index_head_kind")
      .on("memory_index_heads")
      .columns(["tenant_id", "kind", "lifecycle"])
      .execute();

    await db.schema
      .createTable("memory_index_edges")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("space_id", "text", (c) => c.notNull())
      .addColumn("source_note_id", "text", (c) => c.notNull())
      .addColumn("source_revision", "integer", (c) => c.notNull())
      .addColumn("relation", "text", (c) => c.notNull())
      .addColumn("target_note_id", "text", (c) => c.notNull())
      .addColumn("target_revision", "integer")
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("memory_index_edge_pk", [
        "tenant_id",
        "space_id",
        "source_note_id",
        "source_revision",
        "relation",
        "target_note_id",
      ])
      .execute();
    await db.schema
      .createIndex("memory_index_edge_target")
      .on("memory_index_edges")
      .columns(["tenant_id", "target_note_id"])
      .execute();
  },
};
