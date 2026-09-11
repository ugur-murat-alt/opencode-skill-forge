import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client as PgClient } from "pg";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import {
  migrationsFor,
  openDatabase,
  openDatabaseConnection,
} from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { productionJobKinds } from "../src/memory/job-kinds.js";

/**
 * Issue #34 (M01): `032_memory` must be safe both on a fresh open and as an
 * upgrade from the real 031 schema. The upgrade test migrates to 031 with the
 * production migration set, inserts a production-shaped skill run plus an
 * outbox reference, then applies 032 through the migrator and verifies:
 * data preservation, scope backfill (scope_kind=project, scope_key=project_id),
 * the new scope-based uniqueness, nullable project_id, clean FK integrity and
 * that the SQLite foreign_keys pragma was really restored. Each backend uses
 * its own throwaway database.
 */

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#34 fresh open and 031->032 upgrade preserve runs and FK integrity (${backend})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-memory-migration-"));
    const freshRoot = await mkdtemp(join(tmpdir(), "forge-memory-fresh-"));
    const admin =
      backend === "postgres" && process.env.FORGE_TEST_POSTGRES_URL
        ? new PgClient({
            connectionString: process.env.FORGE_TEST_POSTGRES_URL,
          })
        : undefined;
    await admin?.connect();
    const upgradeDb = `forge_mem_up_${crypto.randomUUID().replaceAll("-", "")}`;
    const freshDb = `forge_mem_fresh_${crypto.randomUUID().replaceAll("-", "")}`;
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
      // 1. Gerçek 031 şeması: yalnız 032 öncesi migration'lar uygulanır.
      const migrations = migrationsFor(backend);
      const pre032 = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "032_memory"),
      );
      const first = await new Migrator({
        db: upgrade.db,
        provider: { getMigrations: async () => pre032 },
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
        .insertInto("projects")
        .values({
          tenant_id: "tenant-1",
          id: "project-1",
          name: "Proje",
          environment_id: null,
          created_at: now,
        })
        .execute();
      await upgrade.db
        .insertInto("forge_sessions")
        .values({
          tenant_id: "tenant-1",
          id: "session-1",
          user_id: "user-1",
          project_id: "project-1",
          created_at: now,
        })
        .execute();
      // Eski skill run'ı tam olarak 031 kolonlarıyla yazılır.
      await upgrade.db
        .insertInto("runs")
        .values({
          tenant_id: "tenant-1",
          id: "run-1",
          session_id: "session-1",
          user_id: "user-1",
          project_id: "project-1",
          kind: "skill_evolve",
          state: "queued",
          idempotency_key: "key-1",
          input_hash: "hash-1",
          input_json: "{}",
          config_json: "{}",
          result_json: null,
          error_code: null,
          created_at: now,
          updated_at: now,
          available_at: now,
          deadline_at: now + 60_000,
          lease_until: 0,
          worker_id: null,
          fence: 0,
          attempt: 0,
          max_attempts: 3,
        })
        .execute();
      await upgrade.db
        .insertInto("outbox")
        .values({ tenant_id: "tenant-1", run_id: "run-1", delivered: 0 })
        .execute();
      if (backend === "sqlite") {
        // Upgrade anında FK zorlaması açık: pragma OFF gerçekten çalışmazsa
        // `drop table runs` outbox referansı yüzünden patlardı.
        const before = await sql<{
          foreign_keys: number;
        }>`pragma foreign_keys`.execute(upgrade.db);
        expect(Number(before.rows[0]!.foreign_keys)).toBe(1);
      }

      // 2. 032'yi gerçek migrator ile uygula.
      const second = await new Migrator({
        db: upgrade.db,
        provider: { getMigrations: async () => migrations },
      }).migrateToLatest();
      expect(second.error).toBeUndefined();

      // 3. Veri korunur; eski run proje kapsamına backfill edilir.
      const run = await upgrade.db
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", "run-1")
        .executeTakeFirstOrThrow();
      expect(run.project_id).toBe("project-1");
      expect(run.scope_kind).toBe("project");
      expect(run.scope_key).toBe("project-1");
      expect(run.kind).toBe("skill_evolve");
      expect(run.state).toBe("queued");
      expect(run.input_hash).toBe("hash-1");
      const outbox = await upgrade.db
        .selectFrom("outbox")
        .selectAll()
        .where("run_id", "=", "run-1")
        .execute();
      expect(outbox).toHaveLength(1);

      // 4. Tekillik artık kapsam çiftine bağlı: aynı proje+kapsam+kind+key
      // reddedilir, farklı kapsamda aynı anahtar kabul edilir.
      let duplicated = false;
      try {
        await upgrade.db
          .insertInto("runs")
          .values({
            tenant_id: "tenant-1",
            id: "run-dup",
            session_id: "session-1",
            user_id: "user-1",
            project_id: "project-1",
            scope_kind: "project",
            scope_key: "project-1",
            kind: "skill_evolve",
            state: "queued",
            idempotency_key: "key-1",
            input_hash: "hash-1",
            input_json: "{}",
            config_json: "{}",
            result_json: null,
            error_code: null,
            created_at: now,
            updated_at: now,
            available_at: now,
            deadline_at: now + 60_000,
            lease_until: 0,
            worker_id: null,
            fence: 0,
            attempt: 0,
            max_attempts: 3,
          })
          .execute();
      } catch {
        duplicated = true;
      }
      expect(duplicated).toBe(true);
      await upgrade.db
        .insertInto("runs")
        .values({
          tenant_id: "tenant-1",
          id: "run-personal",
          session_id: "session-1",
          user_id: "user-1",
          project_id: null,
          scope_kind: "personal",
          scope_key: "user-1",
          kind: "memory_ingest",
          state: "queued",
          idempotency_key: "key-1",
          input_hash: "hash-2",
          input_json: "{}",
          config_json: "{}",
          result_json: null,
          error_code: null,
          created_at: now,
          updated_at: now,
          available_at: now,
          deadline_at: now + 60_000,
          lease_until: 0,
          worker_id: null,
          fence: 0,
          attempt: 0,
          max_attempts: 3,
        })
        .execute();

      // 5. Projesiz oturum da yazılabilir; yeni hafıza tabloları hazır.
      await upgrade.db
        .insertInto("forge_sessions")
        .values({
          tenant_id: "tenant-1",
          id: "session-2",
          user_id: "user-1",
          project_id: null,
          created_at: now,
        })
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
      expect(
        await upgrade.db.selectFrom("memory_notes").select(["id"]).execute(),
      ).toHaveLength(0);
      expect(
        await upgrade.db.selectFrom("memory_events").select(["id"]).execute(),
      ).toHaveLength(0);

      if (backend === "sqlite") {
        // 6. Bitişte FK bütünlüğü temiz ve pragma geri açık.
        const check = await sql`pragma foreign_key_check`.execute(upgrade.db);
        expect(check.rows).toHaveLength(0);
        const state = await sql<{
          foreign_keys: number;
        }>`pragma foreign_keys`.execute(upgrade.db);
        expect(Number(state.rows[0]!.foreign_keys)).toBe(1);
      }

      // 7. Taze açılış: hiç migration çalışmamış bir veritabanı ve gerçek
      // kuyruk kabulü.
      await upgrade.close();
      fresh = await openDatabase({
        dataDir: freshRoot,
        ...(backend === "postgres" ? { postgresUrl: urlFor(freshDb) } : {}),
      });
      const identities = new IdentityService(fresh.db);
      const owner = await identities.bootstrapLocal();
      const queue = new JobQueue(
        fresh,
        { memoryEnabled: true },
        productionJobKinds,
      );
      const accepted = await queue.accept(owner, {
        scope: { type: "personal" },
        kind: "memory_reconcile",
        key: "fresh-1",
        payload: {},
      });
      expect(accepted.status).toBe("accepted");
      expect(accepted.run.project_id).toBeNull();
      expect(accepted.run.scope_kind).toBe("personal");
      expect(accepted.run.scope_key).toBe(owner.userId);
      expect(
        await fresh.db.selectFrom("memory_spaces").select(["id"]).execute(),
      ).toHaveLength(0);
      if (backend === "sqlite") {
        const state = await sql<{
          foreign_keys: number;
        }>`pragma foreign_keys`.execute(fresh.db);
        expect(Number(state.rows[0]!.foreign_keys)).toBe(1);
      }
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
}
