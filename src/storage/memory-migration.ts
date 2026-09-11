import type { Migration } from "kysely/migration";
import { sql, type Kysely } from "kysely";
import type { DB } from "./schema.js";
import type { Backend } from "./database.js";

/**
 * Issue #34 (M01): memory ownership contract.
 *
 * - `runs`/`forge_sessions` gain a typed scope: `scope_kind` +
 *   `scope_key` and a nullable `project_id` (personal/organization runs have
 *   no project, and one is never fabricated). The idempotency key moves from
 *   `project_id` to the scope pair.
 * - New tables own spaces, accepted note heads/revisions and durable source
 *   events. Markdown remains the portable note source; these tables carry
 *   identity/ACL and the accepted revision manifest.
 *
 * SQLite needs a real table rebuild (it cannot drop NOT NULL or a UNIQUE
 * constraint in place), which requires foreign_keys=OFF outside the
 * transaction; `PRAGMA foreign_key_check` proves the rebuilt schema is
 * consistent before commit. PostgreSQL alters in place.
 */
export function memoryMigration(backend: Backend): Migration {
  return {
    up: async (db) => {
      if (backend === "sqlite") await migrateSqlite(db);
      else await migratePostgres(db);
      await createMemoryTables(db);
    },
  };
}

async function migrateSqlite(db: Kysely<DB>) {
  // SQLite pragma is a no-op inside a transaction; set it on the migration
  // connection first, then rebuild inside one transaction and restore it in
  // `finally`. If this were a silent no-op the implicit DELETE of `drop
  // table runs` would violate outbox/run_attempts FKs and the migration
  // would fail loudly (covered by test/memory-migration.test.ts).
  await sql`pragma foreign_keys = off`.execute(db);
  try {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .createTable("forge_sessions_new")
        .addColumn("tenant_id", "text", (c) => c.notNull())
        .addColumn("id", "text", (c) => c.notNull())
        .addColumn("user_id", "text", (c) => c.notNull())
        .addColumn("project_id", "text")
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addPrimaryKeyConstraint("fs_pk", ["tenant_id", "id"])
        .addForeignKeyConstraint(
          "fs_project",
          ["tenant_id", "project_id"],
          "projects",
          ["tenant_id", "id"],
        )
        .addForeignKeyConstraint(
          "fs_member",
          ["tenant_id", "user_id"],
          "memberships",
          ["tenant_id", "user_id"],
        )
        .execute();
      await sql`insert into forge_sessions_new (tenant_id, id, user_id, project_id, created_at)
        select tenant_id, id, user_id, project_id, created_at from forge_sessions`.execute(
        trx,
      );
      await trx.schema.dropTable("forge_sessions").execute();
      await trx.schema
        .alterTable("forge_sessions_new")
        .renameTo("forge_sessions")
        .execute();

      await trx.schema
        .createTable("runs_new")
        .addColumn("tenant_id", "text", (c) => c.notNull())
        .addColumn("id", "text", (c) => c.notNull())
        .addColumn("session_id", "text", (c) => c.notNull())
        .addColumn("user_id", "text", (c) => c.notNull())
        .addColumn("project_id", "text")
        .addColumn("scope_kind", "text", (c) =>
          c.notNull().defaultTo("project"),
        )
        .addColumn("scope_key", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("state", "text", (c) => c.notNull())
        .addColumn("idempotency_key", "text", (c) => c.notNull())
        .addColumn("input_hash", "text", (c) => c.notNull())
        .addColumn("input_json", "text", (c) => c.notNull())
        .addColumn("config_json", "text", (c) => c.notNull())
        .addColumn("result_json", "text")
        .addColumn("error_code", "text")
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addColumn("updated_at", "bigint", (c) => c.notNull())
        .addColumn("available_at", "bigint", (c) => c.notNull())
        .addColumn("deadline_at", "bigint", (c) => c.notNull())
        .addColumn("lease_until", "bigint", (c) => c.notNull().defaultTo(0))
        .addColumn("worker_id", "text")
        .addColumn("fence", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("attempt", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("max_attempts", "integer", (c) => c.notNull().defaultTo(3))
        .addPrimaryKeyConstraint("run_pk", ["tenant_id", "id"])
        .addUniqueConstraint("run_dedup", [
          "tenant_id",
          "user_id",
          "scope_kind",
          "scope_key",
          "kind",
          "idempotency_key",
        ])
        .addForeignKeyConstraint(
          "run_project",
          ["tenant_id", "project_id"],
          "projects",
          ["tenant_id", "id"],
        )
        .addForeignKeyConstraint(
          "run_member",
          ["tenant_id", "user_id"],
          "memberships",
          ["tenant_id", "user_id"],
        )
        .addForeignKeyConstraint(
          "run_session",
          ["tenant_id", "session_id"],
          "forge_sessions",
          ["tenant_id", "id"],
        )
        .execute();
      // Existing rows are all project-scope: scope_key mirrors project_id.
      await sql`insert into runs_new (
        tenant_id, id, session_id, user_id, project_id, scope_kind, scope_key,
        kind, state, idempotency_key, input_hash, input_json, config_json,
        result_json, error_code, created_at, updated_at, available_at,
        deadline_at, lease_until, worker_id, fence, attempt, max_attempts
      ) select
        tenant_id, id, session_id, user_id, project_id, 'project', project_id,
        kind, state, idempotency_key, input_hash, input_json, config_json,
        result_json, error_code, created_at, updated_at, available_at,
        deadline_at, lease_until, worker_id, fence, attempt, max_attempts
      from runs`.execute(trx);
      await trx.schema.dropTable("runs").execute();
      await trx.schema.alterTable("runs_new").renameTo("runs").execute();
      await trx.schema
        .createIndex("run_claim")
        .on("runs")
        .columns(["state", "available_at", "lease_until", "created_at"])
        .execute();
      await trx.schema
        .createIndex("run_user_state")
        .on("runs")
        .columns(["tenant_id", "user_id", "state"])
        .execute();

      // Fail closed: a rebuild that left a dangling reference must not commit.
      const check = await sql<{
        table: string;
      }>`pragma foreign_key_check`.execute(trx);
      if (check.rows.length > 0)
        throw new Error(
          `memory migration left ${check.rows.length} foreign key violation(s)`,
        );
    });
  } finally {
    await sql`pragma foreign_keys = on`.execute(db);
  }
}

async function migratePostgres(db: Kysely<DB>) {
  await sql`alter table forge_sessions alter column project_id drop not null`.execute(
    db,
  );
  await sql`alter table runs drop constraint run_dedup`.execute(db);
  await sql`alter table runs alter column project_id drop not null`.execute(db);
  await sql`alter table runs add column scope_kind text not null default 'project'`.execute(
    db,
  );
  await sql`alter table runs add column scope_key text`.execute(db);
  await sql`update runs set scope_key = project_id where scope_key is null`.execute(
    db,
  );
  await sql`alter table runs alter column scope_key set not null`.execute(db);
  await sql`alter table runs add constraint run_dedup unique (
    tenant_id, user_id, scope_kind, scope_key, kind, idempotency_key
  )`.execute(db);
}

async function createMemoryTables(db: Kysely<DB>) {
  await db.schema
    .createTable("memory_spaces")
    .addColumn("tenant_id", "text", (c) => c.notNull())
    .addColumn("id", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("owner_user_id", "text", (c) => c.notNull())
    .addColumn("project_id", "text")
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("memory_space_pk", ["tenant_id", "id"])
    .addForeignKeyConstraint(
      "memory_space_owner",
      ["tenant_id", "owner_user_id"],
      "memberships",
      ["tenant_id", "user_id"],
    )
    .addForeignKeyConstraint(
      "memory_space_project",
      ["tenant_id", "project_id"],
      "projects",
      ["tenant_id", "id"],
    )
    .execute();
  // At most one personal space per user and one project space per project;
  // organization spaces stay unrestricted (their name is not an identity).
  await sql`create unique index memory_space_personal_unique
    on memory_spaces (tenant_id, owner_user_id) where kind = 'personal'`.execute(
    db,
  );
  await sql`create unique index memory_space_project_unique
    on memory_spaces (tenant_id, project_id) where project_id is not null`.execute(
    db,
  );
  await db.schema
    .createIndex("memory_space_tenant_kind")
    .on("memory_spaces")
    .columns(["tenant_id", "kind"])
    .execute();

  await db.schema
    .createTable("memory_notes")
    .addColumn("tenant_id", "text", (c) => c.notNull())
    .addColumn("space_id", "text", (c) => c.notNull())
    .addColumn("id", "text", (c) => c.notNull())
    .addColumn("lifecycle", "text", (c) => c.notNull().defaultTo("active"))
    .addColumn("pinned", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("task_status", "text")
    .addColumn("current_revision", "integer")
    .addColumn("format_version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("summary", "text")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .addColumn("superseded_by", "text")
    .addPrimaryKeyConstraint("memory_note_pk", ["tenant_id", "space_id", "id"])
    .addForeignKeyConstraint(
      "memory_note_space",
      ["tenant_id", "space_id"],
      "memory_spaces",
      ["tenant_id", "id"],
    )
    .execute();
  await db.schema
    .createIndex("memory_note_lifecycle")
    .on("memory_notes")
    .columns(["tenant_id", "space_id", "lifecycle"])
    .execute();

  await db.schema
    .createTable("memory_note_revisions")
    .addColumn("tenant_id", "text", (c) => c.notNull())
    .addColumn("space_id", "text", (c) => c.notNull())
    .addColumn("note_id", "text", (c) => c.notNull())
    .addColumn("revision", "integer", (c) => c.notNull())
    .addColumn("format_version", "integer", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("summary", "text")
    .addColumn("body_md", "text", (c) => c.notNull())
    .addColumn("metadata_json", "text", (c) => c.notNull())
    .addColumn("sources_json", "text", (c) => c.notNull())
    .addColumn("base_revision", "integer")
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("memory_revision_pk", [
      "tenant_id",
      "space_id",
      "note_id",
      "revision",
    ])
    .addForeignKeyConstraint(
      "memory_revision_note",
      ["tenant_id", "space_id", "note_id"],
      "memory_notes",
      ["tenant_id", "space_id", "id"],
    )
    .execute();

  await db.schema
    .createTable("memory_events")
    .addColumn("tenant_id", "text", (c) => c.notNull())
    .addColumn("space_id", "text", (c) => c.notNull())
    .addColumn("id", "text", (c) => c.notNull())
    .addColumn("source_event_key", "text", (c) => c.notNull())
    .addColumn("source_kind", "text", (c) => c.notNull())
    .addColumn("content_hash", "text", (c) => c.notNull())
    .addColumn("state", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("observed_at", "bigint")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .addColumn("committed_revision", "integer")
    .addPrimaryKeyConstraint("memory_event_pk", ["tenant_id", "id"])
    .addUniqueConstraint("memory_event_source", [
      "tenant_id",
      "space_id",
      "source_event_key",
    ])
    .addForeignKeyConstraint(
      "memory_event_space",
      ["tenant_id", "space_id"],
      "memory_spaces",
      ["tenant_id", "id"],
    )
    .execute();
  await db.schema
    .createIndex("memory_event_state")
    .on("memory_events")
    .columns(["tenant_id", "space_id", "state"])
    .execute();
}
