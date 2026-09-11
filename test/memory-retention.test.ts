import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryRetentionService } from "../src/memory/retention.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";
import { defaultSettings, resolveSettings } from "../src/domain/settings.js";
import { existsSync } from "node:fs";

/**
 * Issue #41 (M08): retention classes, explicit forgetting and replay guards.
 * Real SQLite DB and vault; no native client, no model.
 */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forge-retention-"));
  const dataDir = root;
  const storage = await openDatabase({ dataDir });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const memory = new MemoryService(storage.db, identities, vaultRoot(root));
  const space = await memory.ensureSpace(owner, { type: "personal" });
  const index = new MemoryIndexService(storage.db, vaultRoot(root), memory);
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: vaultRoot(root),
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
    const receipt = await commits.commit({
      identity: owner,
      spaceId: space.id,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
      noteId,
      baseRevision: null,
      kind,
    });
    return { receipt, content };
  };
  return {
    root,
    storage,
    identities,
    owner,
    memory,
    space,
    index,
    commits,
    seedNote,
  };
}

test("retention prunes only terminal records and never notes or revisions", async () => {
  const ctx = await setup();
  try {
    const { storage, owner, space, seedNote } = ctx;
    await seedNote("keep-note", "Kalıcı karar");
    const day = 86_400_000;
    const old = Date.now() - 10 * day;
    await storage.db
      .insertInto("memory_events")
      .values({
        tenant_id: owner.tenantId,
        space_id: space.id,
        id: "old-committed",
        source_event_key: "old-committed",
        source_kind: "manual",
        content_hash: "a".repeat(64),
        state: "committed",
        observed_at: old,
        created_at: old,
        updated_at: old,
        committed_revision: 1,
        note_id: "keep-note",
        error_code: null,
        receipt_json: null,
        attempts: 1,
        indexed_at: null,
      })
      .execute();
    await storage.db
      .insertInto("memory_events")
      .values({
        tenant_id: owner.tenantId,
        space_id: space.id,
        id: "old-pending",
        source_event_key: "old-pending",
        source_kind: "manual",
        content_hash: "b".repeat(64),
        state: "pending",
        observed_at: old,
        created_at: old,
        updated_at: old,
        committed_revision: null,
        note_id: "keep-note",
        error_code: null,
        receipt_json: null,
        attempts: 0,
        indexed_at: null,
      })
      .execute();
    await storage.db
      .insertInto("memory_change_candidates")
      .values({
        tenant_id: owner.tenantId,
        id: "old-applied",
        source_id: null,
        path: "x.md",
        note_id: null,
        previous_hash: null,
        observed_hash: null,
        base_revision: null,
        state: "applied",
        reason: null,
        created_at: old,
        updated_at: old,
      })
      .execute();
    await storage.db
      .insertInto("memory_change_candidates")
      .values({
        tenant_id: owner.tenantId,
        id: "open-candidate",
        source_id: null,
        path: "y.md",
        note_id: null,
        previous_hash: null,
        observed_hash: null,
        base_revision: null,
        state: "candidate",
        reason: null,
        created_at: old,
        updated_at: old,
      })
      .execute();
    for (const state of ["delivered", "pending"] as const)
      await storage.db
        .insertInto("memory_spool")
        .values({
          id: `spool-${state}`,
          installation_id: "i",
          project_ref: "p",
          client: "codex",
          event: "Stop",
          session_id: "s",
          turn_ref: null,
          worktree_key: null,
          event_id: `e-${state}`,
          source_kind: "k",
          kind: "session",
          content: "x",
          content_hash: "c".repeat(64),
          content_bytes: 1,
          state,
          attempts: 0,
          next_attempt_at: 0,
          run_id: null,
          last_error: null,
          observed_at: old,
          created_at: old,
          updated_at: old,
        })
        .execute();
    for (const stamp of [old, Date.now()])
      await storage.db
        .insertInto("memory_curator_extractions")
        .values({
          id: `extract-${stamp}`,
          tenant_id: owner.tenantId,
          space_id: space.id,
          run_id: "r",
          mode: "auto",
          extractor_version: "v1",
          policy_version: "p1",
          source_fingerprint: "fp",
          status: "ready",
          result_json: null,
          usage_json: null,
          error_code: null,
          created_at: stamp,
        })
        .execute();
    const retention = new MemoryRetentionService({
      db: storage.db,
      vaultRoot: vaultRoot(ctx.root),
      settings: {
        ...defaultSettings,
        memoryCaptureRetentionDays: 1,
        memoryDeliveryRetentionDays: 1,
        memoryDiagnosticRetentionDays: 1,
      },
    });
    const report = await retention.run();
    expect(report.events_deleted).toBe(1);
    expect(report.events_pending_kept).toBe(1);
    expect(report.candidates_deleted).toBe(1);
    expect(report.candidates_open_kept).toBe(1);
    expect(report.spool_deleted).toBe(1);
    expect(report.extractions_deleted).toBe(1);
    expect(report.notes_touched).toBe(0);
    const remainingEvents = await storage.db
      .selectFrom("memory_events")
      .select("id")
      .orderBy("id")
      .execute();
    expect(remainingEvents.map((row) => row.id)).not.toContain("old-committed");
    expect(remainingEvents.map((row) => row.id)).toContain("old-pending");
    expect(remainingEvents).toHaveLength(2);
    expect(
      await storage.db
        .selectFrom("memory_change_candidates")
        .select("id")
        .execute(),
    ).toEqual([{ id: "open-candidate" }]);
    expect(
      await storage.db.selectFrom("memory_spool").select("id").execute(),
    ).toEqual([{ id: "spool-pending" }]);
    const notes = await storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.deleted_at).toBeNull();
    const revisions = await storage.db
      .selectFrom("memory_note_revisions")
      .selectAll()
      .execute();
    expect(revisions).toHaveLength(1);
    const runs = await storage.db
      .selectFrom("memory_retention_runs")
      .selectAll()
      .execute();
    expect(runs).toHaveLength(1);
  } finally {
    await ctx.storage.close();
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("archive invalidates derived rows and replay cannot revive a tombstone", async () => {
  const ctx = await setup();
  try {
    const { storage, owner, space, memory, commits, seedNote } = ctx;
    const { receipt } = await seedNote("arch-note", "Arşiv kararı");
    expect(
      await storage.db
        .selectFrom("memory_index_heads")
        .selectAll()
        .where("note_id", "=", "arch-note")
        .execute(),
    ).toHaveLength(1);
    await memory.archiveNote(owner, { spaceId: space.id, noteId: "arch-note" });
    for (const table of [
      "memory_index_heads",
      "memory_index_terms",
      "memory_index_edges",
    ] as const)
      expect(
        await storage.db
          .selectFrom(table)
          .selectAll()
          .where("note_id", "=", "arch-note")
          .execute(),
      ).toHaveLength(0);
    const content = "# Arşiv kararı\n\nReplay gövdesi";
    const event = await memory.recordEvent(owner, {
      spaceId: space.id,
      sourceEventKey: "replay-arch",
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    await expect(
      commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: event.event.id,
        sourceKind: "manual",
        content,
        noteId: "arch-note",
        baseRevision: receipt.revision,
        kind: "decision",
      }),
    ).rejects.toThrow();
    const note = await storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("id", "=", "arch-note")
      .executeTakeFirstOrThrow();
    expect(note.deleted_at).not.toBeNull();
  } finally {
    await ctx.storage.close();
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("purge removes rows and files, leaves a durable receipt, and blocks replay", async () => {
  const ctx = await setup();
  try {
    const { storage, owner, space, memory, commits, seedNote } = ctx;
    const { receipt } = await seedNote("purge-note", "Unutulacak karar");
    const revision = await storage.db
      .selectFrom("memory_note_revisions")
      .select(["file_path"])
      .where("note_id", "=", "purge-note")
      .where("revision", "=", receipt.revision)
      .executeTakeFirstOrThrow();
    const filePath = join(vaultRoot(ctx.root), revision.file_path!);
    expect(existsSync(filePath)).toBe(true);
    const retention = new MemoryRetentionService({
      db: storage.db,
      vaultRoot: vaultRoot(ctx.root),
      settings: defaultSettings,
    });
    const purged = await retention.purgeNote(owner, {
      spaceId: space.id,
      noteId: "purge-note",
      reason: "kullanıcı unutma isteği",
    });
    expect(purged.status).toBe("purged");
    expect(purged.files_deleted).toBe(1);
    expect(existsSync(filePath)).toBe(false);
    expect(
      await storage.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("id", "=", "purge-note")
        .execute(),
    ).toHaveLength(0);
    const purge = await storage.db
      .selectFrom("memory_purges")
      .selectAll()
      .where("note_id", "=", "purge-note")
      .executeTakeFirstOrThrow();
    expect(purge.reason).toContain("unutma");
    const again = await retention.purgeNote(owner, {
      spaceId: space.id,
      noteId: "purge-note",
      reason: "tekrar",
    });
    expect(again.status).toBe("already_purged");

    const content = "# Unutulacak karar\n\nReplay";
    const event = await memory.recordEvent(owner, {
      spaceId: space.id,
      sourceEventKey: "replay-purge",
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    await expect(
      commits.commit({
        identity: owner,
        spaceId: space.id,
        eventId: event.event.id,
        sourceKind: "manual",
        content,
        noteId: "purge-note",
        baseRevision: null,
        kind: "decision",
      }),
    ).rejects.toThrow(/unutuldu|purged/i);
  } finally {
    await ctx.storage.close();
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("retention windows are configurable and a restore without purge data demands reconciliation", async () => {
  const ctx = await setup();
  try {
    const narrowed = resolveSettings(
      {
        memoryDeliveryRetentionDays: 90,
        memoryDiagnosticRetentionDays: 60,
      },
      [{ source: "project", values: { memoryDeliveryRetentionDays: 7 } }],
    );
    expect(narrowed.values.memoryDeliveryRetentionDays).toBe(7);
    expect(narrowed.values.memoryDiagnosticRetentionDays).toBe(60);
    const retention = new MemoryRetentionService({
      db: ctx.storage.db,
      vaultRoot: vaultRoot(ctx.root),
      settings: defaultSettings,
    });
    let status = await retention.restoreStatus();
    expect(status.reconciliation_required).toBe(false);
    await ctx.storage.db
      .insertInto("memory_restore_receipts")
      .values({
        id: "restore-legacy",
        backend: "sqlite",
        manifest_created_at: null,
        purges_included: 0,
        purges_applied: 0,
        reconciled_at: null,
        created_at: Date.now(),
      })
      .execute();
    status = await retention.restoreStatus();
    expect(status.reconciliation_required).toBe(true);
    expect(await retention.reconcileRestore()).toEqual({ reconciled: 1 });
    status = await retention.restoreStatus();
    expect(status.reconciliation_required).toBe(false);
  } finally {
    await ctx.storage.close();
    await rm(ctx.root, { recursive: true, force: true });
  }
});
