import { test, expect } from "bun:test";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryContextService } from "../src/memory/context.js";
import { MemoryRetentionService } from "../src/memory/retention.js";
import {
  memoryBackupSummary,
  memoryReferences,
  reconcileRestoredMemory,
} from "../src/backup/memory.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";
import { defaultSettings } from "../src/domain/settings.js";

/**
 * Issue #41 (M08): the memory backup manifest and the restore reconciliation
 * half, against a real SQLite DB + vault copy. The native snapshot path
 * (`backupSqlite`/`restoreSqlite`) additionally runs under Node and is
 * exercised by the CLI test when the built artifact contains memory support.
 */
async function setupSource() {
  const root = await mkdtemp(join(tmpdir(), "forge-backup-mem-"));
  const source = join(root, "source");
  await mkdir(source, { recursive: true, mode: 0o700 });
  const storage = await openDatabase({ dataDir: source });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const memory = new MemoryService(storage.db, identities, vaultRoot(source));
  const space = await memory.ensureSpace(owner, { type: "personal" });
  const index = new MemoryIndexService(storage.db, vaultRoot(source), memory);
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: vaultRoot(source),
    service: memory,
    index,
  });
  const seedNote = async (noteId: string, title: string, kind = "decision") => {
    const content = `# ${title}\n\nGövde ${noteId}`;
    const event = await memory.recordEvent(owner, {
      spaceId: space.id,
      sourceEventKey: `seed-${noteId}`,
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    return commits.commit({
      identity: owner,
      spaceId: space.id,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
      noteId,
      baseRevision: null,
      kind,
    });
  };
  return {
    root,
    source,
    storage,
    identities,
    owner,
    memory,
    space,
    commits,
    seedNote,
  };
}

function queryOn(path: string) {
  const db = new Database(path);
  try {
    return {
      run: (sql: string) => db.prepare(sql).all() as unknown[],
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

test("backup manifest carries head/revision hashes and purge receipts; restore rebuilds derived state", async () => {
  const ctx = await setupSource();
  try {
    const { owner, space, seedNote } = ctx;
    await seedNote("backup-note", "Yedeklenen karar");
    const forgotten = await seedNote("forgotten-note", "Unutulacak not");
    const retention = new MemoryRetentionService({
      db: ctx.storage.db,
      vaultRoot: vaultRoot(ctx.source),
      settings: defaultSettings,
    });
    await retention.purgeNote(owner, {
      spaceId: space.id,
      noteId: "forgotten-note",
      reason: "yedek testi",
    });
    expect(forgotten.revision).toBe(1);

    const raw = queryOn(join(ctx.source, "local.sqlite"));
    let summary: Awaited<ReturnType<typeof memoryBackupSummary>> = null;
    try {
      summary = await memoryBackupSummary(raw.run);
      expect(summary).not.toBeNull();
      expect(summary!.counts.notes).toBe(1);
      expect(summary!.counts.revisions).toBe(1);
      expect(summary!.counts.revision_files).toBe(1);
      expect(summary!.counts.purges).toBe(1);
      expect(summary!.db_migration).toBe("040_memory_retention_bigint");
      expect(summary!.purges[0]!.note_id).toBe("forgotten-note");
      const refs = await memoryReferences(raw.run);
      const memoryPaths = [...refs.keys()].filter((path) =>
        path.startsWith("memory/"),
      );
      expect(memoryPaths).toHaveLength(1);
      expect(refs.get(memoryPaths[0]!)!.hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      raw.close();
    }

    // Simulated restore into an empty target: DB + vault copy, then a legacy
    // target (purge receipts and derived index absent) is reconciled.
    const target = join(ctx.root, "restored");
    await cp(ctx.source, target, { recursive: true });
    const stripped = await openDatabase({ dataDir: target });
    try {
      await stripped.db.deleteFrom("memory_purges").execute();
      await stripped.db.deleteFrom("memory_index_terms").execute();
      await stripped.db.deleteFrom("memory_index_edges").execute();
      await stripped.db.deleteFrom("memory_index_heads").execute();
    } finally {
      await stripped.close();
    }
    const reconciled = await reconcileRestoredMemory({
      dataDir: target,
      backend: "sqlite",
      manifestCreatedAt: "2026-09-11T00:00:00.000Z",
      memory: summary,
    });
    expect(reconciled.purges_applied).toBe(1);
    expect(reconciled.indexed).toBeGreaterThanOrEqual(1);
    expect(reconciled.reconciliation_required).toBe(false);

    const restored = await openDatabase({ dataDir: target });
    try {
      const purge = await restored.db
        .selectFrom("memory_purges")
        .selectAll()
        .where("note_id", "=", "forgotten-note")
        .executeTakeFirstOrThrow();
      expect(purge.source).toBe("backup");
      const restoredMemory = new MemoryService(
        restored.db,
        undefined,
        vaultRoot(target),
      );
      const context = await new MemoryContextService(
        restored.db,
        restoredMemory,
      ).context(
        {
          tenantId: ctx.owner.tenantId,
          userId: ctx.owner.userId,
        },
        { spaceId: ctx.space.id },
      );
      expect(context.cards.map((card) => card.note_id)).toContain(
        "backup-note",
      );
      expect(context.cards.map((card) => card.note_id)).not.toContain(
        "forgotten-note",
      );
      const status = await new MemoryRetentionService({
        db: restored.db,
        vaultRoot: vaultRoot(target),
        settings: defaultSettings,
      }).restoreStatus();
      expect(status.reconciliation_required).toBe(false);
    } finally {
      await restored.close();
    }
  } finally {
    await ctx.storage.close();
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("a legacy manifest without the purge section requires operator reconciliation", async () => {
  const ctx = await setupSource();
  try {
    const { seedNote } = ctx;
    await seedNote("legacy-note", "Eski yedek notu");
    const target = join(ctx.root, "legacy-restored");
    await cp(ctx.source, target, { recursive: true });
    const reconciled = await reconcileRestoredMemory({
      dataDir: target,
      backend: "sqlite",
      manifestCreatedAt: null,
      memory: null,
    });
    expect(reconciled.purges_applied).toBe(0);
    expect(reconciled.reconciliation_required).toBe(true);
    const restored = await openDatabase({ dataDir: target });
    try {
      const status = await new MemoryRetentionService({
        db: restored.db,
        vaultRoot: vaultRoot(target),
        settings: defaultSettings,
      }).restoreStatus();
      expect(status.reconciliation_required).toBe(true);
      expect(status.last_receipt?.purges_included).toBe(false);
    } finally {
      await restored.close();
    }
  } finally {
    await ctx.storage.close();
    await rm(ctx.root, { recursive: true, force: true });
  }
});
