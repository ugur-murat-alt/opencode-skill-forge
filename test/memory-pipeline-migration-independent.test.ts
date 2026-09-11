import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import {
  migrationsFor,
  openDatabase,
  openDatabaseConnection,
} from "../src/storage/database.js";

/**
 * Bağımsız M02 (#35) migration testi: gerçek 032 şemasına üretim şeklinde
 * satırlar yazılır, `033_memory_pipeline` uygulanır ve veri korunumu, yeni
 * kolon varsayılanları, yeni tablolar ve FK bütünlüğü doğrulanır. Ardından
 * taze açılış aynı veritabanında çalışır (SQLite + scratch PostgreSQL).
 */

const NOW = 1_700_000_000_000;

async function prepare(backend: "sqlite" | "postgres") {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-m02-mig-ind-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  let databaseName: string | undefined;
  if (backend === "postgres") {
    databaseName = `forge_m02_mig_ind_${crypto.randomUUID().replaceAll("-", "")}`;
    admin = new PgClient({
      connectionString: process.env.FORGE_TEST_POSTGRES_URL,
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
    url.pathname = `/${databaseName}`;
    postgresUrl = url.toString();
  }
  return {
    dataDir,
    postgresUrl,
    cleanup: async () => {
      if (admin && databaseName) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? (["postgres"] as const) : []),
] as const) {
  test(`#35 bağımsız migration: 032 -> 033 veri korur, yeni kolonlar varsayılanlı (${backend})`, async () => {
    const env = await prepare(backend);
    const connection = await openDatabaseConnection({
      dataDir: env.dataDir,
      ...(env.postgresUrl ? { postgresUrl: env.postgresUrl } : {}),
    });
    try {
      const migrations = migrationsFor(backend);
      const pre033 = Object.fromEntries(
        Object.entries(migrations).filter(
          ([name]) => name < "033_memory_pipeline",
        ),
      );
      const first = await new Migrator({
        db: connection.db,
        provider: { getMigrations: async () => pre033 },
      }).migrateToLatest();
      expect(first.error).toBeUndefined();

      // 032 şemasında üretim şeklinde satırlar.
      await connection.db
        .insertInto("tenants")
        .values({ id: "mig-tenant", name: "T", created_at: NOW })
        .execute();
      await connection.db
        .insertInto("users")
        .values({
          id: "mig-user",
          subject: "mig-user",
          display_name: "U",
          created_at: NOW,
        })
        .execute();
      await connection.db
        .insertInto("memberships")
        .values({
          tenant_id: "mig-tenant",
          user_id: "mig-user",
          role: "founder",
        })
        .execute();
      await connection.db
        .insertInto("projects")
        .values({
          tenant_id: "mig-tenant",
          id: "mig-project",
          name: "P",
          environment_id: null,
          created_at: NOW,
        })
        .execute();
      await connection.db
        .insertInto("memory_spaces")
        .values({
          tenant_id: "mig-tenant",
          id: "mig-space",
          kind: "personal",
          owner_user_id: "mig-user",
          project_id: null,
          name: "Kişisel",
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      await connection.db
        .insertInto("memory_notes")
        .values({
          tenant_id: "mig-tenant",
          space_id: "mig-space",
          id: "mig-note",
          lifecycle: "active",
          pinned: 1,
          task_status: "doing",
          current_revision: 3,
          format_version: 1,
          title: "Eski not",
          summary: "özet",
          created_at: NOW,
          updated_at: NOW,
          superseded_by: null,
        })
        .execute();
      await connection.db
        .insertInto("memory_note_revisions")
        .values({
          tenant_id: "mig-tenant",
          space_id: "mig-space",
          note_id: "mig-note",
          revision: 3,
          format_version: 1,
          kind: "note",
          title: "Eski not",
          summary: "özet",
          body_md: "Eski gövde.",
          metadata_json: "{}",
          sources_json: "[]",
          base_revision: 2,
          created_by: "mig-user",
          created_at: NOW,
        })
        .execute();
      await connection.db
        .insertInto("memory_events")
        .values({
          tenant_id: "mig-tenant",
          space_id: "mig-space",
          id: "mig-event",
          source_event_key: "mig-key",
          source_kind: "manual",
          content_hash: "a".repeat(64),
          state: "pending",
          observed_at: null,
          created_at: NOW,
          updated_at: NOW,
          committed_revision: null,
        })
        .execute();

      const second = await new Migrator({
        db: connection.db,
        provider: { getMigrations: async () => migrations },
      }).migrateToLatest();
      expect(second.error).toBeUndefined();

      const note = await connection.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("id", "=", "mig-note")
        .executeTakeFirstOrThrow();
      expect(note).toMatchObject({
        lifecycle: "active",
        pinned: 1,
        task_status: "doing",
        current_revision: 3,
        title: "Eski not",
        summary: "özet",
      });
      expect(note.source_id).toBeNull();
      expect(note.source_path).toBeNull();
      expect(note.source_hash).toBeNull();
      expect(note.source_state).toBe("present");
      expect(note.deleted_at).toBeNull();
      const revision = await connection.db
        .selectFrom("memory_note_revisions")
        .selectAll()
        .where("revision", "=", 3)
        .executeTakeFirstOrThrow();
      expect(revision.body_md).toBe("Eski gövde.");
      expect(revision.file_path).toBeNull();
      expect(revision.content_hash).toBeNull();
      expect(revision.byte_size).toBeNull();
      const event = await connection.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", "mig-event")
        .executeTakeFirstOrThrow();
      expect(event.state).toBe("pending");
      expect(event.error_code).toBeNull();
      expect(event.receipt_json).toBeNull();
      expect(Number(event.attempts)).toBe(0);
      expect(event.indexed_at).toBeNull();
      // Yeni tablolar boş ve kullanılabilir.
      expect(
        await connection.db
          .selectFrom("memory_sources")
          .select(["id"])
          .execute(),
      ).toHaveLength(0);
      expect(
        await connection.db
          .selectFrom("memory_change_candidates")
          .select(["id"])
          .execute(),
      ).toHaveLength(0);
      await connection.db
        .insertInto("memory_sources")
        .values({
          tenant_id: "mig-tenant",
          id: "mig-source",
          space_id: "mig-space",
          root_path: "/tmp/mig-source",
          mode: "read_only",
          cursor_json: null,
          checkpoint: null,
          last_scan_at: null,
          status: "active",
          created_by: "mig-user",
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      let duplicate = false;
      try {
        await connection.db
          .insertInto("memory_sources")
          .values({
            tenant_id: "mig-tenant",
            id: "mig-source-2",
            space_id: "mig-space",
            root_path: "/tmp/mig-source",
            mode: "managed",
            cursor_json: null,
            checkpoint: null,
            last_scan_at: null,
            status: "active",
            created_by: "mig-user",
            created_at: NOW,
            updated_at: NOW,
          })
          .execute();
      } catch {
        duplicate = true;
      }
      expect(duplicate).toBe(true);
      if (backend === "sqlite") {
        const fk = await sql`pragma foreign_key_check`.execute(connection.db);
        expect(fk.rows).toHaveLength(0);
        const pragma = await sql`pragma foreign_keys`.execute(connection.db);
        expect(Number(pragma.rows[0]!.foreign_keys)).toBe(1);
      }
      await connection.close();

      // Taze açılış aynı veriyi okur.
      const fresh = await openDatabase({
        dataDir: env.dataDir,
        ...(env.postgresUrl ? { postgresUrl: env.postgresUrl } : {}),
      });
      try {
        expect(
          (
            await fresh.db
              .selectFrom("memory_notes")
              .select(["id"])
              .where("id", "=", "mig-note")
              .execute()
          ).length,
        ).toBe(1);
        expect(
          (
            await fresh.db
              .selectFrom("memory_events")
              .select(["id"])
              .where("id", "=", "mig-event")
              .execute()
          ).length,
        ).toBe(1);
      } finally {
        await fresh.close();
      }
    } finally {
      await env.cleanup();
    }
  }, 60000);
}
