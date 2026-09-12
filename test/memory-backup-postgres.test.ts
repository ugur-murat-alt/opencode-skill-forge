import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryRetentionService } from "../src/memory/retention.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";
import { defaultSettings } from "../src/domain/settings.js";

const exec = promisify(execFile);
const DIST = resolve("dist/cli.js");
const distHasMemory =
  existsSync(DIST) && readFileSync(DIST, "utf8").includes("memory_purges");

/**
 * Issue #41 (M08): real PostgreSQL backup/restore proof for the memory
 * section. The SQLite path is covered by memory-backup-cli.test.ts; this test
 * exercises the same CLI snapshot through pg_dump/pg_restore against a live
 * server, including accepted Markdown files, durable purge receipts and the
 * derived index rebuild after restore.
 *
 * The host client may be older than the server, so dump/restore run through
 * the same pinned PostgreSQL 17 image the core PostgreSQL backup test uses.
 * When the invoking shell has a private /tmp (e.g. systemd PrivateTmp), point
 * TMPDIR at a directory the Docker daemon can also see so the bind mount
 * resolves to the same files.
 */
test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL || !distHasMemory)(
  "Node PostgreSQL memory backup/restore carries accepted Markdown, purge receipts and rebuilds the index",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-backup-pg-mem-"));
    const source = join(root, "source"),
      backup = join(root, "backup"),
      restored = join(root, "restored");
    await mkdir(source, { recursive: true, mode: 0o700 });
    const admin = new Client({
      connectionString: process.env.FORGE_TEST_POSTGRES_URL,
    });
    await admin.connect();
    const sourceName = `forge_mem_backup_${crypto.randomUUID().replaceAll("-", "")}`;
    const targetName = `forge_mem_restore_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${sourceName}"`);
    const sourceUrl = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
    sourceUrl.pathname = `/${sourceName}`;
    for (const tool of ["pg_dump", "pg_restore"]) {
      await writeFile(
        join(root, tool),
        `#!/bin/sh\nexec docker run --rm --network host --user ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} -e PGDATABASE -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGCONNECT_TIMEOUT -v '${root}:${root}' postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73 ${tool} "$@"\n`,
        { mode: 0o700 },
      );
    }
    const run = (command: string, src: string, dst: string) =>
      exec(
        "node",
        [
          DIST,
          command,
          "--data-dir",
          src,
          "--output",
          dst,
          ...(command === "restore" ? ["--database-name", targetName] : []),
        ],
        {
          env: {
            ...process.env,
            SKILL_FORGE_POSTGRES_URL: sourceUrl.toString(),
            SKILL_FORGE_PG_DUMP: join(root, "pg_dump"),
            SKILL_FORGE_PG_RESTORE: join(root, "pg_restore"),
            SKILL_FORGE_DATA_DIR: src,
            OC_SKILL_POWER_HOME: join(root, "legacy"),
          },
          timeout: 180_000,
        },
      );
    try {
      const storage = await openDatabase({
        dataDir: source,
        postgresUrl: sourceUrl.toString(),
      });
      try {
        const identities = new IdentityService(storage.db);
        const owner = await identities.bootstrapLocal();
        const memory = new MemoryService(
          storage.db,
          identities,
          vaultRoot(source),
        );
        const space = await memory.ensureSpace(owner, { type: "personal" });
        const index = new MemoryIndexService(
          storage.db,
          vaultRoot(source),
          memory,
        );
        const commits = new MemoryCommitService({
          db: storage.db,
          vaultRoot: vaultRoot(source),
          service: memory,
          index,
        });
        const content = "# PG yedek kararı\n\nKabul edilmiş Markdown.";
        const event = await memory.recordEvent(owner, {
          spaceId: space.id,
          sourceEventKey: "pg-backup-note",
          sourceKind: "manual",
          contentHash: sha256Hex(content),
        });
        const committed = await commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: event.event.id,
          sourceKind: "manual",
          content,
          noteId: "pg-backup-note",
          baseRevision: null,
          kind: "decision",
        });
        expect(committed.revision).toBe(1);
        const forgetContent = "# Unut\n\nPG purge gövdesi.";
        const forgetEvent = await memory.recordEvent(owner, {
          spaceId: space.id,
          sourceEventKey: "pg-forget-note",
          sourceKind: "manual",
          contentHash: sha256Hex(forgetContent),
        });
        await commits.commit({
          identity: owner,
          spaceId: space.id,
          eventId: forgetEvent.event.id,
          sourceKind: "manual",
          content: forgetContent,
          noteId: "pg-forget-note",
          baseRevision: null,
          kind: "note",
        });
        await new MemoryRetentionService({
          db: storage.db,
          vaultRoot: vaultRoot(source),
          settings: defaultSettings,
        }).purgeNote(owner, {
          spaceId: space.id,
          noteId: "pg-forget-note",
          reason: "pg kabul testi",
        });
      } finally {
        await storage.close();
      }

      const created = JSON.parse((await run("backup", source, backup)).stdout);
      expect(created.status).toBe("created");
      expect(created.backend).toBe("postgres");
      const manifest = JSON.parse(
        await readFile(join(backup, "backup.json"), "utf8"),
      );
      expect(manifest.backend).toBe("postgres");
      expect(manifest.memory.counts.notes).toBe(1);
      expect(manifest.memory.counts.revision_files).toBe(1);
      expect(manifest.memory.counts.purges).toBe(1);
      expect(
        manifest.files.some(
          (entry: { path: string }) => entry.path === "postgres.dump",
        ),
      ).toBe(true);
      expect(
        manifest.files.some((entry: { path: string }) =>
          entry.path.startsWith("memory/"),
        ),
      ).toBe(true);

      const restoredResult = JSON.parse(
        (await run("restore", backup, restored)).stdout,
      );
      expect(restoredResult.status).toBe("restored");
      expect(restoredResult.backend).toBe("postgres");
      expect(restoredResult.database).toBe(targetName);
      expect(restoredResult.sessions_revoked).toBe(true);
      expect(restoredResult.memory.purges_applied).toBe(0);
      expect(restoredResult.memory.reconciliation_required).toBe(false);
      expect(restoredResult.memory.indexed).toBeGreaterThanOrEqual(1);

      const targetUrl = new URL(sourceUrl);
      targetUrl.pathname = `/${targetName}`;
      const target = await openDatabase({
        dataDir: restored,
        postgresUrl: targetUrl.toString(),
      });
      try {
        const notes = await target.db
          .selectFrom("memory_notes")
          .select(["id"])
          .execute();
        expect(notes.map((note) => note.id)).toEqual(["pg-backup-note"]);
        const purge = await target.db
          .selectFrom("memory_purges")
          .selectAll()
          .where("note_id", "=", "pg-forget-note")
          .executeTakeFirstOrThrow();
        expect(purge.source).toBe("manual");
        const heads = await target.db
          .selectFrom("memory_index_heads")
          .selectAll()
          .where("note_id", "=", "pg-backup-note")
          .execute();
        expect(heads).toHaveLength(1);
        const receipt = await target.db
          .selectFrom("memory_restore_receipts")
          .selectAll()
          .executeTakeFirstOrThrow();
        expect(receipt.backend).toBe("postgres");
        expect(receipt.purges_included).toBe(1);
      } finally {
        await target.close();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${sourceName}" WITH (FORCE)`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  300_000,
);
