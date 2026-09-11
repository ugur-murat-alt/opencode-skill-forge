import { test, expect } from "bun:test";
import { cp, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Client as PgClient } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryContextService } from "../src/memory/context.js";
import { MemorySearchService } from "../src/memory/search.js";
import { MemoryWriteService } from "../src/memory/writes.js";
import { MemoryRetentionService } from "../src/memory/retention.js";
import {
  memoryBackupSummary,
  memoryReferences,
  reconcileRestoredMemory,
} from "../src/backup/memory.js";
import { defaultSettings } from "../src/domain/settings.js";
import { sha256Hex } from "../src/memory/files.js";
import { resolveVaultRelative, vaultRoot } from "../src/memory/paths.js";

/**
 * Bağımsız M08 (#41) kabulü: retention, unut/sil, backup/restore ve kurtarma
 * sözleşmeleri.
 *
 * - Retention yalnız terminal kayıtları penceresi geçince siler; aktif
 *   not/pin/karar/görev ve kabul edilmiş revision'lar yaşla silinmez.
 * - Arşiv türetilmiş head/term/edge'i geçersizleştirir; replay diriltemez.
 * - Purge satır+sürüm dosyalarını siler, `memory_purges` makbuzu kalır;
 *   replay `memory_note_purged` ile reddedilir.
 * - Backup manifesti head/hash/sayım/migration/purge taşır; boş hedefe
 *   restore + yeniden indeks purge'lu notu diriltmez; purge bölümü olmayan
 *   manifest `reconciliation_required` bırakır.
 * - Dosya sistemi negatifleri: bozuk manifest ve bozulmuş revision dosyası
 *   hedefi geri almadan reddedilir; purge sırasında eksik dosya toleranslıdır.
 *
 * PostgreSQL hücresi ayrı bir scratch DB'de retention/purge makbuzunu koşar;
 * native backup/restore yolu SQLite'a özgüdür (PG yedeği çekirdek testte).
 */

const DAY = 86_400_000;

function queryOn(path: string) {
  const db = new Database(path);
  return {
    all: async (sql: string) => db.prepare(sql).all() as unknown[],
    close: () => db.close(),
  };
}

interface Env {
  root: string;
  storage: DatabaseHandle;
  db: DatabaseHandle["db"];
  identities: IdentityService;
  owner: Identity;
  memory: MemoryService;
  commits: MemoryCommitService;
  index: MemoryIndexService;
  writes: MemoryWriteService;
  spaceId: string;
  close: () => Promise<void>;
}

async function openEnv(
  backend: "sqlite" | "postgres" = "sqlite",
): Promise<Env & { postgresUrl?: string; adminCleanup?: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "forge-m08-ind-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  let databaseName: string | undefined;
  if (backend === "postgres") {
    databaseName = `forge_m08_verify_${crypto.randomUUID().replaceAll("-", "")}`;
    admin = new PgClient({
      connectionString: process.env.FORGE_TEST_POSTGRES_URL,
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
    url.pathname = `/${databaseName}`;
    postgresUrl = url.toString();
  }
  const storage = await openDatabase({
    dataDir: root,
    ...(postgresUrl ? { postgresUrl } : {}),
  });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const vault = vaultRoot(root);
  const memory = new MemoryService(storage.db, identities, vault);
  const index = new MemoryIndexService(storage.db, vault, memory);
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: vault,
    service: memory,
    index,
  });
  const writes = new MemoryWriteService({
    db: storage.db,
    vaultRoot: vault,
    service: memory,
    commits,
  });
  const space = await memory.ensureSpace(owner, { type: "personal" });
  return {
    root,
    storage,
    db: storage.db,
    identities,
    owner,
    memory,
    commits,
    index,
    writes,
    spaceId: space.id,
    postgresUrl,
    adminCleanup: admin
      ? async () => {
          try {
            await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
          } finally {
            await admin.end();
          }
        }
      : undefined,
    close: async () => {
      await storage.close();
    },
  };
}

async function seedNote(
  env: Env,
  input: {
    noteId: string;
    title: string;
    body: string;
    kind?: string;
    pinned?: boolean;
    baseRevision?: number | null;
  },
): Promise<{ revision: number; filePath: string; fileHash: string }> {
  const content = [
    "---",
    "format_version: 1",
    `note_id: ${JSON.stringify(input.noteId)}`,
    `memory_space_id: ${JSON.stringify(env.spaceId)}`,
    `kind: ${input.kind ?? "note"}`,
    `title: ${JSON.stringify(input.title)}`,
    ...(input.pinned ? ["pinned: true"] : []),
    "---",
    "",
    input.body,
    "",
  ].join("\n");
  const event = await env.memory.recordEvent(env.owner, {
    spaceId: env.spaceId,
    sourceEventKey: `m08-${input.noteId}-${input.baseRevision ?? "v1"}-${crypto.randomUUID().slice(0, 8)}`,
    sourceKind: "manual",
    contentHash: sha256Hex(content),
  });
  const receipt = await env.commits.commit({
    identity: env.owner,
    spaceId: env.spaceId,
    eventId: event.event.id,
    sourceKind: "manual",
    content,
    noteId: input.noteId,
    baseRevision: input.baseRevision ?? null,
    kind: input.kind,
  });
  return {
    revision: receipt.revision,
    filePath: receipt.filePath,
    fileHash: receipt.fileHash,
  };
}

async function derivedRowsForNote(env: Env, noteId: string): Promise<number> {
  const heads = await env.db
    .selectFrom("memory_index_heads")
    .select(["note_id"])
    .where("note_id", "=", noteId)
    .execute();
  const terms = await env.db
    .selectFrom("memory_index_terms")
    .select(["note_id"])
    .where("note_id", "=", noteId)
    .execute();
  // Kenarlar note_id değil source/target üzerinden bağlanır.
  const edges = await env.db
    .selectFrom("memory_index_edges")
    .select(["source_note_id"])
    .where((eb) =>
      eb.or([
        eb("source_note_id", "=", noteId),
        eb("target_note_id", "=", noteId),
      ]),
    )
    .execute();
  return heads.length + terms.length + edges.length;
}

function retentionFor(
  env: Env,
  options: { offsetDays?: number; windows?: Record<string, number> } = {},
) {
  return new MemoryRetentionService({
    db: env.db,
    vaultRoot: vaultRoot(env.root),
    settings: {
      ...defaultSettings,
      memoryCaptureRetentionDays: 1,
      memoryDeliveryRetentionDays: 1,
      memoryDiagnosticRetentionDays: 1,
      ...options.windows,
    },
    now: () => Date.now() + (options.offsetDays ?? 0) * DAY,
  });
}

test("retention yalnız terminal kayıtları budar; not/revision/pin/karar korunur", async () => {
  const env = await openEnv();
  try {
    await seedNote(env, {
      noteId: "ret-decision",
      title: "Karar",
      body: "karar gövdesi",
      kind: "decision",
    });
    const task = await seedNote(env, {
      noteId: "ret-task",
      title: "Görev",
      body: "görev gövdesi",
      kind: "task",
    });
    const pinned = await seedNote(env, {
      noteId: "ret-pin",
      title: "Pinli",
      body: "pin gövdesi",
      pinned: true,
    });
    const notesBefore = await env.db
      .selectFrom("memory_notes")
      .select(["id"])
      .execute();
    const revisionsBefore = await env.db
      .selectFrom("memory_note_revisions")
      .select(["file_path"])
      .execute();
    const old = Date.now() - 10 * DAY;

    // Eski terminal olaylar + eski pending olay.
    await env.db
      .updateTable("memory_events")
      .set({ updated_at: old })
      .execute();
    const pendingKey = "retention-pending";
    await env.memory.recordEvent(env.owner, {
      spaceId: env.spaceId,
      sourceEventKey: pendingKey,
      sourceKind: "manual",
      contentHash: sha256Hex("pending"),
    });
    await env.db
      .updateTable("memory_events")
      .set({ updated_at: old })
      .where("source_event_key", "=", pendingKey)
      .execute();

    // Adaylar: açık olanlar korunur, çözülmüş eski silinir.
    const candidate = (id: string, state: string, updatedAt: number) =>
      env.db
        .insertInto("memory_change_candidates")
        .values({
          tenant_id: env.owner.tenantId,
          id,
          source_id: null,
          path: `p/${id}.md`,
          note_id: null,
          previous_hash: null,
          observed_hash: null,
          base_revision: null,
          state: state as never,
          reason: "test",
          created_at: updatedAt,
          updated_at: updatedAt,
        })
        .execute();
    await candidate("cand-applied", "applied", old);
    await candidate("cand-open", "candidate", old);
    await candidate("cand-conflict", "conflict", old);

    // Spool: teslim edilmiş eski silinir, pending korunur.
    const spool = (id: string, state: string, updatedAt: number) =>
      env.db
        .insertInto("memory_spool")
        .values({
          id,
          installation_id: "inst-1",
          project_ref: "proj-1",
          client: "codex",
          event: "stop",
          session_id: "sess-1",
          turn_ref: null,
          worktree_key: null,
          event_id: id,
          source_kind: "hook",
          kind: "session",
          content: "spool",
          content_hash: sha256Hex("spool"),
          content_bytes: 5,
          state: state as never,
          attempts: 0,
          next_attempt_at: 0,
          run_id: null,
          last_error: null,
          observed_at: updatedAt,
          created_at: updatedAt,
          updated_at: updatedAt,
        })
        .execute();
    await spool("spool-delivered", "delivered", old);
    await spool("spool-pending", "pending", old);

    // Süresi geçmiş turn flag silinir, taze olan kalır.
    await env.db
      .insertInto("memory_turn_flags")
      .values({
        installation_id: "inst-1",
        session_id: "sess-1",
        turn_ref: "expired",
        memory_off: 1,
        created_at: old,
        expires_at: old,
      })
      .execute();
    await env.db
      .insertInto("memory_turn_flags")
      .values({
        installation_id: "inst-1",
        session_id: "sess-2",
        turn_ref: "fresh",
        memory_off: 1,
        created_at: Date.now(),
        // +10 günlük retention offset'inde de süresi dolmamış olmalı.
        expires_at: Date.now() + 11 * DAY,
      })
      .execute();

    // Aynı anahtarın eski extraction'ı budanır, yenisi kalır.
    const extraction = (id: string, createdAt: number) =>
      env.db
        .insertInto("memory_curator_extractions")
        .values({
          id,
          tenant_id: env.owner.tenantId,
          space_id: env.spaceId,
          run_id: `run-${id}`,
          mode: "proposal",
          extractor_version: "v1",
          policy_version: "p1",
          source_fingerprint: "f".repeat(64),
          status: "ready",
          result_json: null,
          usage_json: null,
          error_code: null,
          created_at: createdAt,
        })
        .execute();
    await extraction("ext-old", old);
    await extraction("ext-new", Date.now());

    const report = await retentionFor(env, { offsetDays: 10 }).run();
    expect(report.notes_touched).toBe(0);
    expect(report.events_deleted).toBeGreaterThanOrEqual(1);
    expect(report.events_pending_kept).toBe(1);
    expect(report.candidates_deleted).toBe(1);
    expect(report.candidates_open_kept).toBe(2);
    expect(report.spool_deleted).toBe(1);
    expect(report.flags_deleted).toBe(1);
    expect(report.extractions_deleted).toBe(1);

    // Notlar, revision satırları ve dosyaları yerinde.
    expect(
      (await env.db.selectFrom("memory_notes").select(["id"]).execute()).length,
    ).toBe(notesBefore.length);
    for (const revision of revisionsBefore) {
      const content = await readFile(
        resolveVaultRelative(vaultRoot(env.root), revision.file_path!),
        "utf8",
      );
      expect(content.length).toBeGreaterThan(0);
    }
    expect(
      (
        await env.db
          .selectFrom("memory_note_revisions")
          .select(["file_path"])
          .execute()
      ).length,
    ).toBe(revisionsBefore.length);
    for (const id of [task.filePath, pinned.filePath])
      await expect(
        readFile(resolveVaultRelative(vaultRoot(env.root), id), "utf8"),
      ).resolves.toBeDefined();
    // Bekleyen olay hâlâ orada.
    const pendingStill = await env.db
      .selectFrom("memory_events")
      .select(["id"])
      .where("source_event_key", "=", pendingKey)
      .execute();
    expect(pendingStill).toHaveLength(1);
    // Koşum kaydı ve rapor içeriği kalıcı.
    const run = await env.db
      .selectFrom("memory_retention_runs")
      .selectAll()
      .executeTakeFirstOrThrow();
    const stored = JSON.parse(run.report_json) as {
      events_deleted: number;
      notes_touched: number;
    };
    expect(stored.events_deleted).toBe(report.events_deleted);
    expect(stored.notes_touched).toBe(0);
  } finally {
    await env.close();
  }
}, 90000);

test("arşiv türetilmiş indeksi geçersizleştirir; replay tombstone'u diriltemez", async () => {
  const env = await openEnv();
  try {
    const seeded = await seedNote(env, {
      noteId: "archive-note",
      title: "Arşiv notu",
      body: "arşiv gövdesi",
      kind: "decision",
    });
    const context = new MemoryContextService(env.db, env.memory);
    const search = new MemorySearchService(env.db, env.memory);
    const before = await context.context(env.owner, {
      spaceId: env.spaceId,
      maxTokens: 2048,
    });
    expect(before.cards.some((card) => card.note_id === "archive-note")).toBe(
      true,
    );
    await env.writes.update(env.owner, {
      space_id: env.spaceId,
      note_id: "archive-note",
      archive: true,
    } as never);
    expect(await derivedRowsForNote(env, "archive-note")).toBe(0);
    const after = await context.context(env.owner, {
      spaceId: env.spaceId,
      maxTokens: 2048,
    });
    expect(after.cards.some((card) => card.note_id === "archive-note")).toBe(
      false,
    );
    const recalled = await search.search(env.owner, {
      query: "arşiv gövdesi",
      spaceId: env.spaceId,
    });
    expect(recalled.items.some((card) => card.note_id === "archive-note")).toBe(
      false,
    );
    // Replay diriltmez.
    const content = await readFile(
      resolveVaultRelative(vaultRoot(env.root), seeded.filePath),
      "utf8",
    );
    const replayEvent = await env.memory.recordEvent(env.owner, {
      spaceId: env.spaceId,
      sourceEventKey: "archive-replay",
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    let revived: unknown;
    try {
      await env.commits.commit({
        identity: env.owner,
        spaceId: env.spaceId,
        eventId: replayEvent.event.id,
        sourceKind: "manual",
        content,
        noteId: "archive-note",
        baseRevision: seeded.revision,
      });
    } catch (error) {
      revived = error;
    }
    expect((revived as { code?: string }).code).toBe("memory_note_unavailable");
    // Açık restore sonrası yeni revizyon yazılabilir.
    await env.memory.restoreNote(env.owner, {
      spaceId: env.spaceId,
      noteId: "archive-note",
    });
    const content2 = content.replace("arşiv gövdesi", "restore sonrası");
    const event2 = await env.memory.recordEvent(env.owner, {
      spaceId: env.spaceId,
      sourceEventKey: "archive-restore",
      sourceKind: "manual",
      contentHash: sha256Hex(content2),
    });
    const restored = await env.commits.commit({
      identity: env.owner,
      spaceId: env.spaceId,
      eventId: event2.event.id,
      sourceKind: "manual",
      content: content2,
      noteId: "archive-note",
      baseRevision: seeded.revision,
    });
    expect(restored.revision).toBe(seeded.revision + 1);
  } finally {
    await env.close();
  }
}, 90000);

test.failing(
  "arşiv türetilmiş graph kenarlarını da geçersizleştirmeli (SQLite sızıntısı / PG 42703)",
  async () => {
    const env = await openEnv();
    try {
      await seedNote(env, { noteId: "inv-a", title: "A", body: "a" });
      await seedNote(env, { noteId: "inv-b", title: "B", body: "b" });
      await env.writes.link(env.owner, {
        space_id: env.spaceId,
        note_id: "inv-a",
        relation: "SUPPORTS",
        target_note_id: "inv-b",
        expected_revision: 1,
      } as never);
      const before = await env.db
        .selectFrom("memory_index_edges")
        .select(["source_note_id"])
        .where("source_note_id", "=", "inv-a")
        .execute();
      expect(before).toHaveLength(1);
      // PostgreSQL'de bu çağrı 42703 ile düşer; SQLite'ta sessizce kenar kalır.
      await env.memory.archiveNote(env.owner, {
        spaceId: env.spaceId,
        noteId: "inv-a",
      });
      const after = await env.db
        .selectFrom("memory_index_edges")
        .select(["source_note_id"])
        .where("source_note_id", "=", "inv-a")
        .execute();
      expect(after).toHaveLength(0);
    } finally {
      await env.close();
    }
  },
  90000,
);

test("purge satır+dosya siler, makbuz kalır; replay memory_note_purged; idempotent", async () => {
  const env = await openEnv();
  try {
    const target = await seedNote(env, {
      noteId: "purge-me",
      title: "Unutulacak",
      body: "silinecek gövde",
    });
    await seedNote(env, {
      noteId: "keep-me",
      title: "Kalacak",
      body: "korunacak gövde",
    });
    await env.memory.archiveNote(env.owner, {
      spaceId: env.spaceId,
      noteId: "purge-me",
    });
    const retention = retentionFor(env);
    const purged = await retention.purgeNote(env.owner, {
      spaceId: env.spaceId,
      noteId: "purge-me",
      reason: "kullanıcı unutmak istedi",
    });
    expect(purged.status).toBe("purged");
    expect(purged.files_deleted).toBe(1);
    // Satırlar gitti, dosya gitti.
    expect(
      await env.db
        .selectFrom("memory_notes")
        .select(["id"])
        .where("id", "=", "purge-me")
        .execute(),
    ).toHaveLength(0);
    expect(
      await env.db
        .selectFrom("memory_note_revisions")
        .select(["file_path"])
        .where("note_id", "=", "purge-me")
        .execute(),
    ).toHaveLength(0);
    await expect(
      readFile(resolveVaultRelative(vaultRoot(env.root), target.filePath)),
    ).rejects.toThrow();
    // Makbuz kalıcı ve kaynak alanlı.
    const receipt = await env.db
      .selectFrom("memory_purges")
      .selectAll()
      .where("note_id", "=", "purge-me")
      .executeTakeFirstOrThrow();
    expect(receipt.reason).toBe("kullanıcı unutmak istedi");
    expect(receipt.source).toBe("manual");
    // Diğer not zarar görmedi.
    expect(
      await env.db
        .selectFrom("memory_notes")
        .select(["id"])
        .where("id", "=", "keep-me")
        .execute(),
    ).toHaveLength(1);
    // Replay diriltemez.
    const content = [
      "---",
      "format_version: 1",
      'note_id: "purge-me"',
      `memory_space_id: ${JSON.stringify(env.spaceId)}`,
      "kind: note",
      'title: "Unutulacak"',
      "---",
      "",
      "yeni içerik",
      "",
    ].join("\n");
    const event = await env.memory.recordEvent(env.owner, {
      spaceId: env.spaceId,
      sourceEventKey: "purge-replay",
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    let replay: unknown;
    try {
      await env.commits.commit({
        identity: env.owner,
        spaceId: env.spaceId,
        eventId: event.event.id,
        sourceKind: "manual",
        content,
        noteId: "purge-me",
        baseRevision: null,
      });
    } catch (error) {
      replay = error;
    }
    expect((replay as { code?: string }).code).toBe("memory_note_purged");
    // İkinci purge idempotent; bilinmeyen not 404.
    const again = await retention.purgeNote(env.owner, {
      spaceId: env.spaceId,
      noteId: "purge-me",
      reason: "tekrar",
    });
    expect(again.status).toBe("already_purged");
    let missing: unknown;
    try {
      await retention.purgeNote(env.owner, {
        spaceId: env.spaceId,
        noteId: "yok-böyle",
        reason: "x",
      });
    } catch (error) {
      missing = error;
    }
    expect((missing as { code?: string }).code).toBe("memory_note_unavailable");
    const audit = await env.db
      .selectFrom("audit_events")
      .select(["kind"])
      .where("kind", "=", "memory.note.purged")
      .execute();
    expect(audit).toHaveLength(1);
  } finally {
    await env.close();
  }
}, 90000);

test("backup manifesti hash/sayım/purge taşır; restore purge'u diriltmez ve yeniden indeksler", async () => {
  const env = await openEnv();
  try {
    await seedNote(env, {
      noteId: "backup-note",
      title: "Yedek notu",
      body: "yedek gövdesi",
      kind: "decision",
    });
    await seedNote(env, {
      noteId: "backup-forgotten",
      title: "Unutulan",
      body: "gidecek",
    });
    await env.memory.archiveNote(env.owner, {
      spaceId: env.spaceId,
      noteId: "backup-forgotten",
    });
    await retentionFor(env).purgeNote(env.owner, {
      spaceId: env.spaceId,
      noteId: "backup-forgotten",
      reason: "yedek öncesi unutuldu",
    });
    const sourceDb = join(env.root, "local.sqlite");
    const summary = await memoryBackupSummary(async (sql) =>
      queryOn(sourceDb).all(sql),
    );
    expect(summary).not.toBeNull();
    expect(summary!.counts.notes).toBe(1);
    expect(summary!.counts.revisions).toBe(1);
    expect(summary!.counts.revision_files).toBe(1);
    expect(summary!.counts.purges).toBe(1);
    expect(summary!.db_migration).toMatch(/^0\d\d_/);
    const references = await memoryReferences(async (sql) =>
      queryOn(sourceDb).all(sql),
    );
    expect(references.size).toBe(1);
    const [referencePath, reference] = [...references.entries()][0]!;
    expect(referencePath).toMatch(/^memory\/spaces\//);
    const referenceBytes = await readFile(
      join(env.root, referencePath),
      "utf8",
    );
    expect(sha256Hex(referenceBytes)).toBe(reference.hash);

    // Boş hedefe kopyala ve uzlaştır. WAL içeriği ana dosyaya indirilmeden
    // kopyalanırsa kabul edilmiş satırlar kaybolur (SQLite WAL).
    const checkpoint = new Database(sourceDb);
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint.close();
    const restoredRoot = await mkdtemp(join(tmpdir(), "forge-m08-restored-"));
    await cp(sourceDb, join(restoredRoot, "local.sqlite"));
    await cp(join(env.root, "memory"), join(restoredRoot, "memory"), {
      recursive: true,
    });
    const reconciled = await reconcileRestoredMemory({
      dataDir: restoredRoot,
      backend: "sqlite",
      manifestCreatedAt: "2026-09-11T00:00:00.000Z",
      memory: summary,
    });
    expect(reconciled.reconciliation_required).toBe(false);
    // Anlık görüntü türetilmiş indeksi de taşır; rebuild idempotenttir ve
    // sıfır yeni satır raporlayabilir. Kanıt: aşağıda context notu bulur.
    expect(typeof reconciled.indexed).toBe("number");
    const restoredStorage = await openDatabase({ dataDir: restoredRoot });
    try {
      const notes = await restoredStorage.db
        .selectFrom("memory_notes")
        .select(["id"])
        .execute();
      expect(notes.map((note) => note.id)).toEqual(["backup-note"]);
      const purges = await restoredStorage.db
        .selectFrom("memory_purges")
        .select(["note_id"])
        .execute();
      expect(purges.map((purge) => purge.note_id)).toEqual([
        "backup-forgotten",
      ]);
      const restoredMemory = new MemoryService(
        restoredStorage.db,
        undefined,
        vaultRoot(restoredRoot),
      );
      const context = new MemoryContextService(
        restoredStorage.db,
        restoredMemory,
      );
      const owner = await new IdentityService(
        restoredStorage.db,
      ).bootstrapLocal();
      const space = (
        await restoredStorage.db
          .selectFrom("memory_spaces")
          .select(["id"])
          .executeTakeFirstOrThrow()
      ).id;
      const pkg = await context.context(owner, {
        spaceId: space,
        maxTokens: 2048,
      });
      expect(pkg.cards.map((card) => card.note_id)).toContain("backup-note");
      const retention = new MemoryRetentionService({
        db: restoredStorage.db,
        vaultRoot: vaultRoot(restoredRoot),
        settings: defaultSettings,
      });
      const status = await retention.restoreStatus();
      expect(status.reconciliation_required).toBe(false);
      expect(status.last_receipt?.purges_included).toBe(true);
    } finally {
      await restoredStorage.close();
      await rm(restoredRoot, { recursive: true, force: true });
    }

    // Purge bölümü olmayan manifest: uzlaştırma zorunlu.
    const checkpointLegacy = new Database(sourceDb);
    checkpointLegacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpointLegacy.close();
    const legacyRoot = await mkdtemp(join(tmpdir(), "forge-m08-legacy-"));
    await cp(sourceDb, join(legacyRoot, "local.sqlite"));
    await cp(join(env.root, "memory"), join(legacyRoot, "memory"), {
      recursive: true,
    });
    const legacy = await reconcileRestoredMemory({
      dataDir: legacyRoot,
      backend: "sqlite",
      manifestCreatedAt: null,
      memory: null,
    });
    expect(legacy.reconciliation_required).toBe(true);
    const legacyStorage = await openDatabase({ dataDir: legacyRoot });
    try {
      const retention = new MemoryRetentionService({
        db: legacyStorage.db,
        vaultRoot: vaultRoot(legacyRoot),
        settings: defaultSettings,
      });
      expect((await retention.restoreStatus()).reconciliation_required).toBe(
        true,
      );
      expect((await retention.reconcileRestore()).reconciled).toBe(1);
      expect((await retention.restoreStatus()).reconciliation_required).toBe(
        false,
      );
      expect((await retention.reconcileRestore()).reconciled).toBe(0);
    } finally {
      await legacyStorage.close();
      await rm(legacyRoot, { recursive: true, force: true });
    }
  } finally {
    await env.close();
  }
}, 120000);

test("purge sırasında eksik revision dosyası (kesinti) işlemi tutarsız bırakmaz", async () => {
  const env = await openEnv();
  try {
    const seeded = await seedNote(env, {
      noteId: "fs-note",
      title: "FS notu",
      body: "fs gövdesi",
    });
    // Dosya daha önce (kesintide) silinmiş gibi davran.
    await unlink(resolveVaultRelative(vaultRoot(env.root), seeded.filePath));
    const purged = await retentionFor(env).purgeNote(env.owner, {
      spaceId: env.spaceId,
      noteId: "fs-note",
      reason: "dosya zaten yok",
    });
    expect(purged.status).toBe("purged");
    expect(purged.files_deleted).toBe(0);
    expect(
      await env.db
        .selectFrom("memory_purges")
        .select(["note_id"])
        .where("note_id", "=", "fs-note")
        .execute(),
    ).toHaveLength(1);
    expect(
      await env.db
        .selectFrom("memory_notes")
        .select(["id"])
        .where("id", "=", "fs-note")
        .execute(),
    ).toHaveLength(0);
  } finally {
    await env.close();
  }
}, 60000);

const pgRetentionTest = process.env.FORGE_TEST_POSTGRES_URL
  ? test.failing
  : test.skip;

pgRetentionTest(
  "PostgreSQL: retention koşumu ve purge makbuzu int4 taşması olmadan kalıcı olmalı",
  async () => {
    const env = await openEnv("postgres");
    try {
      await seedNote(env, {
        noteId: "pg-note",
        title: "PG notu",
        body: "pg gövdesi",
      });
      // int4'e sığmayan ms zaman damgası burada 22003 ile düşer.
      const report = await retentionFor(env, { offsetDays: 40 }).run();
      expect(typeof report.events_deleted).toBe("number");
      const purged = await retentionFor(env).purgeNote(env.owner, {
        spaceId: env.spaceId,
        noteId: "pg-note",
        reason: "pg testi",
      });
      expect(purged.status).toBe("purged");
      expect(
        await env.db
          .selectFrom("memory_purges")
          .select(["note_id", "source"])
          .where("note_id", "=", "pg-note")
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ note_id: "pg-note", source: "manual" });
    } finally {
      await env.close();
      await env.adminCleanup?.();
    }
  },
  120000,
);
