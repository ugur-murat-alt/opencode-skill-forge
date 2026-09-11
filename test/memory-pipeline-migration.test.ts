import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client as PgClient } from "pg";
import { Migrator } from "kysely/migration";
import {
  migrationsFor,
  openDatabase,
  openDatabaseConnection,
} from "../src/storage/database.js";

/**
 * Issue #35 (M02): `033_memory_pipeline` extends 032 additively. The upgrade
 * test applies the real pre-033 migration set, inserts M01-shaped rows, then
 * applies 033 through the migrator and checks preservation plus the new
 * columns/tables. Fresh open is checked on both backends too.
 */

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#35 fresh open and 032->033 upgrade add pipeline columns without data loss (${backend})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-m02-migration-"));
    const freshRoot = await mkdtemp(join(tmpdir(), "forge-m02-fresh-"));
    const admin =
      backend === "postgres" && process.env.FORGE_TEST_POSTGRES_URL
        ? new PgClient({
            connectionString: process.env.FORGE_TEST_POSTGRES_URL,
          })
        : undefined;
    await admin?.connect();
    const upgradeDb = `forge_m02_up_${crypto.randomUUID().replaceAll("-", "")}`;
    const freshDb = `forge_m02_fresh_${crypto.randomUUID().replaceAll("-", "")}`;
    const urlFor = (name: string) => {
      const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
      url.pathname = `/${name}`;
      return url.toString();
    };
    if (backend === "postgres") {
      await admin!.query(`CREATE DATABASE "${upgradeDb}"`);
      await admin!.query(`CREATE DATABASE "${freshDb}"`);
    }
    const upgrade = await openDatabaseConnection({
      dataDir: root,
      ...(backend === "postgres" ? { postgresUrl: urlFor(upgradeDb) } : {}),
    });
    let fresh: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      const migrations = migrationsFor(backend);
      const pre033 = Object.fromEntries(
        Object.entries(migrations).filter(
          ([name]) => name < "033_memory_pipeline",
        ),
      );
      const first = await new Migrator({
        db: upgrade.db,
        provider: { getMigrations: async () => pre033 },
      }).migrateToLatest();
      expect(first.error).toBeUndefined();
      const now = Date.now();
      await upgrade.db
        .insertInto("tenants")
        .values({ id: "tenant-1", name: "Kiracı", created_at: now })
        .execute();
      await upgrade.db
        .insertInto("users")
        .values({
          id: "user-1",
          subject: "subject-1",
          display_name: "Üye",
          created_at: now,
        })
        .execute();
      await upgrade.db
        .insertInto("memberships")
        .values({ tenant_id: "tenant-1", user_id: "user-1", role: "founder" })
        .execute();
      await upgrade.db
        .insertInto("memory_spaces")
        .values({
          tenant_id: "tenant-1",
          id: "space-1",
          kind: "personal",
          owner_user_id: "user-1",
          project_id: null,
          name: "Kişisel",
          created_at: now,
          updated_at: now,
        })
        .execute();
      // 032 şeklinde not/revision/olay satırları.
      await upgrade.db
        .insertInto("memory_notes")
        .values({
          tenant_id: "tenant-1",
          space_id: "space-1",
          id: "note-1",
          lifecycle: "active",
          pinned: 0,
          task_status: null,
          current_revision: 1,
          format_version: 1,
          title: "M01 notu",
          summary: null,
          created_at: now,
          updated_at: now,
          superseded_by: null,
        })
        .execute();
      await upgrade.db
        .insertInto("memory_note_revisions")
        .values({
          tenant_id: "tenant-1",
          space_id: "space-1",
          note_id: "note-1",
          revision: 1,
          format_version: 1,
          kind: "note",
          title: "M01 notu",
          summary: null,
          body_md: "M01 gövdesi",
          metadata_json: "{}",
          sources_json: "[]",
          base_revision: null,
          created_by: "user-1",
          created_at: now,
        })
        .execute();
      await upgrade.db
        .insertInto("memory_events")
        .values({
          tenant_id: "tenant-1",
          space_id: "space-1",
          id: "event-1",
          source_event_key: "evt-1",
          source_kind: "manual",
          content_hash: "a".repeat(64),
          state: "pending",
          observed_at: null,
          created_at: now,
          updated_at: now,
          committed_revision: null,
        })
        .execute();

      const second = await new Migrator({
        db: upgrade.db,
        provider: { getMigrations: async () => migrations },
      }).migrateToLatest();
      expect(second.error).toBeUndefined();

      const note = await upgrade.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("id", "=", "note-1")
        .executeTakeFirstOrThrow();
      expect(note).toMatchObject({
        current_revision: 1,
        title: "M01 notu",
        source_state: "present",
        source_id: null,
        source_path: null,
        source_hash: null,
        deleted_at: null,
      });
      const revision = await upgrade.db
        .selectFrom("memory_note_revisions")
        .selectAll()
        .where("note_id", "=", "note-1")
        .executeTakeFirstOrThrow();
      expect(revision).toMatchObject({
        body_md: "M01 gövdesi",
        file_path: null,
        content_hash: null,
        byte_size: null,
      });
      const event = await upgrade.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", "event-1")
        .executeTakeFirstOrThrow();
      expect(event).toMatchObject({
        state: "pending",
        error_code: null,
        receipt_json: null,
        attempts: 0,
        indexed_at: null,
      });
      // Yeni tablolar yazılabilir.
      await upgrade.db
        .insertInto("memory_sources")
        .values({
          tenant_id: "tenant-1",
          id: "source-1",
          space_id: "space-1",
          root_path: "/tmp/kaynak",
          mode: "read_only",
          cursor_json: null,
          checkpoint: null,
          last_scan_at: null,
          status: "active",
          created_by: "user-1",
          created_at: now,
          updated_at: now,
        })
        .execute();
      await upgrade.db
        .insertInto("memory_change_candidates")
        .values({
          tenant_id: "tenant-1",
          id: "candidate-1",
          source_id: "source-1",
          path: "notlar/a.md",
          note_id: null,
          previous_hash: null,
          observed_hash: "b".repeat(64),
          base_revision: null,
          state: "candidate",
          reason: "new",
          created_at: now,
          updated_at: now,
        })
        .execute();

      await upgrade.close();
      fresh = await openDatabase({
        dataDir: freshRoot,
        ...(backend === "postgres" ? { postgresUrl: urlFor(freshDb) } : {}),
      });
      const freshNoteColumns = await fresh.db
        .selectFrom("memory_notes")
        .select(["source_state", "deleted_at"])
        .limit(0)
        .execute();
      expect(freshNoteColumns).toEqual([]);
      expect(
        await fresh.db.selectFrom("memory_sources").selectAll().execute(),
      ).toEqual([]);
      expect(
        await fresh.db
          .selectFrom("memory_change_candidates")
          .selectAll()
          .execute(),
      ).toEqual([]);
    } finally {
      await upgrade.close().catch(() => undefined);
      await fresh?.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${upgradeDb}" WITH (FORCE)`);
          await admin.query(`DROP DATABASE "${freshDb}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
      await rm(freshRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test(`#35 033->034 adds the event note binding without data loss (${backend})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-m02-note-mig-"));
    const admin =
      backend === "postgres" && process.env.FORGE_TEST_POSTGRES_URL
        ? new PgClient({
            connectionString: process.env.FORGE_TEST_POSTGRES_URL,
          })
        : undefined;
    await admin?.connect();
    const databaseName = `forge_m02_note_${crypto.randomUUID().replaceAll("-", "")}`;
    let postgresUrl: string | undefined;
    if (backend === "postgres") {
      await admin!.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
      url.pathname = `/${databaseName}`;
      postgresUrl = url.toString();
    }
    const handle = await openDatabaseConnection({
      dataDir: root,
      ...(postgresUrl ? { postgresUrl } : {}),
    });
    try {
      const migrations = migrationsFor(backend);
      const pre034 = Object.fromEntries(
        Object.entries(migrations).filter(
          ([name]) => name < "034_memory_event_note",
        ),
      );
      const first = await new Migrator({
        db: handle.db,
        provider: { getMigrations: async () => pre034 },
      }).migrateToLatest();
      expect(first.error).toBeUndefined();
      const now = Date.now();
      await handle.db
        .insertInto("tenants")
        .values({ id: "t1", name: "T", created_at: now })
        .execute();
      await handle.db
        .insertInto("users")
        .values({ id: "u1", subject: "s1", display_name: "U", created_at: now })
        .execute();
      await handle.db
        .insertInto("memberships")
        .values({ tenant_id: "t1", user_id: "u1", role: "founder" })
        .execute();
      await handle.db
        .insertInto("memory_spaces")
        .values({
          tenant_id: "t1",
          id: "sp1",
          kind: "personal",
          owner_user_id: "u1",
          project_id: null,
          name: "S",
          created_at: now,
          updated_at: now,
        })
        .execute();
      await handle.db
        .insertInto("memory_events")
        .values({
          tenant_id: "t1",
          space_id: "sp1",
          id: "ev1",
          source_event_key: "k1",
          source_kind: "manual",
          content_hash: "a".repeat(64),
          state: "committed",
          observed_at: null,
          created_at: now,
          updated_at: now,
          committed_revision: 1,
          error_code: null,
          receipt_json: null,
          attempts: 0,
          indexed_at: null,
        })
        .execute();
      const second = await new Migrator({
        db: handle.db,
        provider: { getMigrations: async () => migrations },
      }).migrateToLatest();
      expect(second.error).toBeUndefined();
      const event = await handle.db
        .selectFrom("memory_events")
        .selectAll()
        .where("id", "=", "ev1")
        .executeTakeFirstOrThrow();
      expect(event.note_id).toBeNull();
      expect(event.state).toBe("committed");
      expect(event.committed_revision).toBe(1);
      await handle.db
        .updateTable("memory_events")
        .set({ note_id: "note-x" })
        .where("id", "=", "ev1")
        .execute();
      expect(
        (
          await handle.db
            .selectFrom("memory_events")
            .select(["note_id"])
            .where("id", "=", "ev1")
            .executeTakeFirstOrThrow()
        ).note_id,
      ).toBe("note-x");
    } finally {
      await handle.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
}
