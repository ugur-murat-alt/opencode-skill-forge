import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
 * Issue #41 (M08): native Node snapshot path for accepted Markdown + purges.
 * Runs only when the built artifact contains the memory backup section.
 */
test.skipIf(!distHasMemory)(
  "Node CLI backup/restore carries accepted Markdown, purge receipts and rebuilds the index",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-backup-cli-mem-"));
    const source = join(root, "source"),
      backup = join(root, "backup"),
      restored = join(root, "restored");
    await mkdir(source, { recursive: true, mode: 0o700 });
    const storage = await openDatabase({ dataDir: source });
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
      const content = "# CLI yedek kararı\n\nKabul edilmiş Markdown.";
      const event = await memory.recordEvent(owner, {
        spaceId: space.id,
        sourceEventKey: "cli-backup-note",
        sourceKind: "manual",
        contentHash: sha256Hex(content),
      });
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: event.event.id,
        sourceKind: "manual",
        content,
        noteId: "cli-backup-note",
        baseRevision: null,
        kind: "decision",
      });
      await commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: (
          await memory.recordEvent(owner, {
            spaceId: space.id,
            sourceEventKey: "cli-forget-note",
            sourceKind: "manual",
            contentHash: sha256Hex("# Unut\n\nx"),
          })
        ).event.id,
        sourceKind: "manual",
        content: "# Unut\n\nx",
        noteId: "cli-forget-note",
        baseRevision: null,
        kind: "note",
      });
      await new MemoryRetentionService({
        db: storage.db,
        vaultRoot: vaultRoot(source),
        settings: defaultSettings,
      }).purgeNote(owner, {
        spaceId: space.id,
        noteId: "cli-forget-note",
        reason: "cli testi",
      });
    } finally {
      await storage.close();
    }
    const run = (command: string, src: string, dst: string) =>
      exec("node", [DIST, command, "--data-dir", src, "--output", dst], {
        env: { ...process.env, SKILL_FORGE_DATA_DIR: src },
      });
    try {
      const created = JSON.parse((await run("backup", source, backup)).stdout);
      expect(created.status).toBe("created");
      const manifest = JSON.parse(
        await readFile(join(backup, "backup.json"), "utf8"),
      );
      expect(manifest.memory.counts.notes).toBe(1);
      expect(manifest.memory.counts.revision_files).toBe(1);
      expect(manifest.memory.counts.purges).toBe(1);
      expect(
        manifest.files.some((entry: { path: string }) =>
          entry.path.startsWith("memory/"),
        ),
      ).toBe(true);

      const restoredResult = JSON.parse(
        (await run("restore", backup, restored)).stdout,
      );
      expect(restoredResult.status).toBe("restored");
      // The snapshot already carries the purge receipt; nothing needs import.
      expect(restoredResult.memory.purges_applied).toBe(0);
      expect(restoredResult.memory.reconciliation_required).toBe(false);
      expect(restoredResult.memory.indexed).toBeGreaterThanOrEqual(1);

      const target = await openDatabase({ dataDir: restored });
      try {
        const notes = await target.db
          .selectFrom("memory_notes")
          .select(["id"])
          .execute();
        expect(notes.map((note) => note.id)).toEqual(["cli-backup-note"]);
        const purge = await target.db
          .selectFrom("memory_purges")
          .selectAll()
          .where("note_id", "=", "cli-forget-note")
          .executeTakeFirstOrThrow();
        expect(purge.source).toBe("manual");
        const heads = await target.db
          .selectFrom("memory_index_heads")
          .selectAll()
          .where("note_id", "=", "cli-backup-note")
          .execute();
        expect(heads).toHaveLength(1);
      } finally {
        await target.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
