import { deletionMigration } from "./deletion-migration.js";
import { promptDrainMigration } from "./prompt-drain-migration.js";
import { inviteMigration } from "./invite-migration.js";
import { roleRenameMigration } from "./role-rename-migration.js";
import { orgLifecycleMigration } from "./org-lifecycle-migration.js";
import { roleRegistryMigration } from "./role-registry-migration.js";
import { agentPromptMigration } from "./agent-prompt-migration.js";
import { environmentMigration } from "./environment-migration.js";
import { environmentUniquenessMigration } from "./environment-uniqueness-migration.js";
import { bindingIdentityMigration } from "./binding-identity-migration.js";
import { readerMigration } from "./reader-migration.js";
import { readerLivenessMigration } from "./reader-liveness-migration.js";
import { runPinMigration } from "./run-pin-migration.js";
import { executionPinMigration } from "./execution-pin-migration.js";
import { flagImportMigration } from "./flag-import-migration.js";
import { sessionPreferenceMigration } from "./session-preference-migration.js";
import { rewriteImportMigration } from "./rewrite-import-migration.js";
import { learningImportMigration } from "./learning-import-migration.js";
import { learningHistoryMigration } from "./learning-history-migration.js";
import { importMigration } from "./import-migration.js";
import { membershipMigration } from "./membership-migration.js";
import { observationMigration } from "./observation-migration.js";
import { installationMigration } from "./installation-migration.js";
import { learningMigration } from "./learning-migration.js";
import { executionMigration } from "./execution-migration.js";
import { skillMigration } from "./skill-migration.js";
import { providerMigration } from "./provider-migration.js";
import { jobMigration } from "./job-migration.js";
import { Migrator, type Migration } from "kysely/migration";
import {
  Kysely,
  SqliteDialect,
  PostgresDialect,
  sql,
  type SqliteDatabase,
} from "kysely";
import { Pool, types } from "pg";
import { join } from "node:path";
import type { DB } from "./schema.js";
export type Backend = "sqlite" | "postgres";
export async function openDatabase(options: {
  dataDir: string;
  postgresUrl?: string;
}) {
  let dialect;
  const backend: Backend = options.postgresUrl ? "postgres" : "sqlite";
  if (options.postgresUrl) {
    types.setTypeParser(20, (value) => Number(value));
    dialect = new PostgresDialect({
      pool: new Pool({
        connectionString: options.postgresUrl,
        max: 12,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      }),
    });
  } else {
    const path = join(options.dataDir, "local.sqlite");
    let sqlite: SqliteDatabase;
    if (process.versions.bun) {
      const { Database } = await import("bun:sqlite");
      const native = new Database(path, { create: true });
      native.exec(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
      );
      sqlite = {
        close: () => native.close(),
        prepare: (query) => {
          const stmt = native.prepare(query);
          return {
            reader: stmt.columnNames.length > 0,
            all: (params) => stmt.all(...(params as never[])),
            run: (params) => stmt.run(...(params as never[])),
            iterate: (params) => stmt.iterate(...(params as never[])),
          };
        },
      };
    } else {
      const { default: Database } = await import("better-sqlite3");
      const native = new Database(path);
      native.pragma("journal_mode = WAL");
      native.pragma("foreign_keys = ON");
      native.pragma("busy_timeout = 5000");
      native.pragma("synchronous = FULL");
      sqlite = native;
    }
    dialect = new SqliteDialect({ database: sqlite });
  }
  const db = new Kysely<DB>({ dialect });
  const migrations: Record<string, Migration> = {
    "028_environment_uniqueness": environmentUniquenessMigration,
    "027_agent_prompts": agentPromptMigration,
    "026_binding_identity": bindingIdentityMigration,
    "025_environments": environmentMigration,
    "024_role_registry": roleRegistryMigration,
    "023_org_lifecycle": orgLifecycleMigration,
    "022_role_rename": roleRenameMigration,
    "021_invitations": inviteMigration,
    "020_prompt_drain": promptDrainMigration,
    "019_package_deletion": deletionMigration,
    "018_revision_readers": readerMigration,
    "029_reader_liveness": readerLivenessMigration,
    "017_run_pins": runPinMigration,
    "016_execution_pins": executionPinMigration,
    "015_flag_import": flagImportMigration,
    "014_session_preferences": sessionPreferenceMigration,
    "013_rewrite_import": rewriteImportMigration,
    "012_learning_import": learningImportMigration,
    "011_learning_history": learningHistoryMigration,
    "010_import_receipts": importMigration,
    "009_memberships": membershipMigration,
    "008_observations": observationMigration,
    "007_installations": installationMigration,
    "006_learning": learningMigration,
    "005_executions": executionMigration,
    "002_jobs": jobMigration,
    "003_providers": providerMigration,
    "004_skills": skillMigration(backend),
    "001_identity": {
      up: async (database) => {
        await database.schema
          .createTable("tenants")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("name", "text", (c) => c.notNull())
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .execute();
        await database.schema
          .createTable("users")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("subject", "text", (c) => c.unique().notNull())
          .addColumn("display_name", "text", (c) => c.notNull())
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .execute();
        await database.schema
          .createTable("memberships")
          .addColumn("tenant_id", "text", (c) =>
            c.notNull().references("tenants.id"),
          )
          .addColumn("user_id", "text", (c) =>
            c.notNull().references("users.id"),
          )
          .addColumn("role", "text", (c) => c.notNull())
          .addPrimaryKeyConstraint("membership_pk", ["tenant_id", "user_id"])
          .execute();
        await database.schema
          .createTable("projects")
          .addColumn("tenant_id", "text", (c) =>
            c.notNull().references("tenants.id"),
          )
          .addColumn("id", "text", (c) => c.notNull())
          .addColumn("name", "text", (c) => c.notNull())
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addPrimaryKeyConstraint("project_pk", ["tenant_id", "id"])
          .execute();
        await database.schema
          .createTable("project_members")
          .addColumn("tenant_id", "text", (c) => c.notNull())
          .addColumn("project_id", "text", (c) => c.notNull())
          .addColumn("user_id", "text", (c) => c.notNull())
          .addColumn("role", "text", (c) => c.notNull())
          .addPrimaryKeyConstraint("project_member_pk", [
            "tenant_id",
            "project_id",
            "user_id",
          ])
          .addForeignKeyConstraint(
            "pm_project",
            ["tenant_id", "project_id"],
            "projects",
            ["tenant_id", "id"],
          )
          .addForeignKeyConstraint(
            "pm_member",
            ["tenant_id", "user_id"],
            "memberships",
            ["tenant_id", "user_id"],
          )
          .execute();
        await database.schema
          .createTable("project_bindings")
          .addColumn("tenant_id", "text", (c) => c.notNull())
          .addColumn("project_id", "text", (c) => c.notNull())
          .addColumn("user_id", "text", (c) => c.notNull())
          .addColumn("client_id", "text", (c) => c.notNull())
          .addColumn("path", "text", (c) => c.notNull())
          .addPrimaryKeyConstraint("binding_pk", [
            "tenant_id",
            "user_id",
            "client_id",
            "path",
          ])
          .addForeignKeyConstraint(
            "binding_project",
            ["tenant_id", "project_id"],
            "projects",
            ["tenant_id", "id"],
          )
          .addForeignKeyConstraint(
            "binding_member",
            ["tenant_id", "user_id"],
            "memberships",
            ["tenant_id", "user_id"],
          )
          .execute();
        await database.schema
          .createTable("config_revisions")
          .addColumn("tenant_id", "text", (c) =>
            c.notNull().references("tenants.id"),
          )
          .addColumn("id", "text", (c) => c.notNull())
          .addColumn("scope_key", "text", (c) => c.notNull())
          .addColumn("revision", "integer", (c) => c.notNull())
          .addColumn("payload", "text", (c) => c.notNull())
          .addColumn("created_by", "text", (c) => c.notNull())
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addPrimaryKeyConstraint("config_pk", ["tenant_id", "id"])
          .addUniqueConstraint("config_scope_revision", [
            "tenant_id",
            "scope_key",
            "revision",
          ])
          .addForeignKeyConstraint(
            "config_member",
            ["tenant_id", "created_by"],
            "memberships",
            ["tenant_id", "user_id"],
          )
          .execute();
        await database.schema
          .createTable("auth_sessions")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("user_id", "text", (c) =>
            c.notNull().references("users.id"),
          )
          .addColumn("token_hash", "text", (c) => c.notNull().unique())
          .addColumn("expires_at", "bigint", (c) => c.notNull())
          .addColumn("revoked", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("kind", "text", (c) => c.notNull())
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .execute();
        await database.schema
          .createTable("audit_events")
          .addColumn("tenant_id", "text", (c) =>
            c.notNull().references("tenants.id"),
          )
          .addColumn("id", "text", (c) => c.notNull())
          .addColumn("user_id", "text", (c) => c.notNull())
          .addColumn("project_id", "text")
          .addColumn("kind", "text", (c) => c.notNull())
          .addColumn("detail", "text", (c) => c.notNull())
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addPrimaryKeyConstraint("audit_pk", ["tenant_id", "id"])
          .addForeignKeyConstraint(
            "audit_member",
            ["tenant_id", "user_id"],
            "memberships",
            ["tenant_id", "user_id"],
          )
          .execute();
        await database.schema
          .createIndex("audit_time")
          .on("audit_events")
          .columns(["tenant_id", "created_at", "id"])
          .execute();
        await database.schema
          .createIndex("auth_expiry")
          .on("auth_sessions")
          .columns(["expires_at", "revoked"])
          .execute();
      },
    },
  };
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });
  const result = await migrator.migrateToLatest();
  if (result.error) {
    await db.destroy();
    throw result.error;
  }
  return {
    db,
    backend,
    close: () => db.destroy(),
    now: async () => {
      const result =
        backend === "postgres"
          ? await sql<{
              now: number;
            }>`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now`.execute(
              db,
            )
          : await sql<{
              now: number;
            }>`select cast((julianday('now') - 2440587.5) * 86400000 as integer) as now`.execute(
              db,
            );
      return Number(result.rows[0]!.now);
    },
  };
}
export type DatabaseHandle = Awaited<ReturnType<typeof openDatabase>>;
