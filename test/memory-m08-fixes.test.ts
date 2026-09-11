import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryWriteService } from "../src/memory/writes.js";
import {
  MemoryRetentionService,
  recordRestoreReceipt,
} from "../src/memory/retention.js";
import { vaultRoot } from "../src/memory/paths.js";
import { sha256Hex } from "../src/memory/files.js";
import { defaultSettings } from "../src/domain/settings.js";
import { ForgeError } from "../src/domain/errors.js";
import {
  setupCurator,
  scriptedStream,
  toolMessage,
} from "./curator-fixtures.test.js";

/**
 * Independent-acceptance fixes (#41 follow-up): per-table edge invalidation,
 * durable-then-cleanup purge order, PostgreSQL bigint timestamps and the
 * curator apply note_id binding. Each runs on SQLite and PostgreSQL when
 * `FORGE_TEST_POSTGRES_URL` is set.
 */

const BACKENDS = [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? (["postgres"] as const) : []),
] as const;

async function setup(backend: (typeof BACKENDS)[number]) {
  const root = await mkdtemp(join(tmpdir(), "forge-m08-fix-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  if (backend === "postgres") {
    const name = `forge_m08_fix_${crypto.randomUUID().replaceAll("-", "")}`;
    admin = new PgClient({
      connectionString: process.env.FORGE_TEST_POSTGRES_URL,
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
    url.pathname = `/${name}`;
    postgresUrl = url.toString();
  }
  const storage = await openDatabase({ dataDir: root, postgresUrl });
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
  const writes = new MemoryWriteService({
    db: storage.db,
    service: memory,
    commits,
    vaultRoot: vaultRoot(root),
  });
  const seed = async (noteId: string, title: string, kind = "decision") => {
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
    storage,
    owner,
    memory,
    space,
    writes,
    seed,
    close: async () => {
      await storage.close();
      if (admin) {
        await admin
          .query(
            `DROP DATABASE IF EXISTS "${new URL(postgresUrl!).pathname.slice(1)}"`,
          )
          .catch(() => undefined);
        await admin.end();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const backend of BACKENDS) {
  test(`[${backend}] archive purges derived terms/heads/edges in both directions`, async () => {
    const ctx = await setup(backend);
    try {
      await ctx.seed("edge-a", "A kararı");
      await ctx.seed("edge-b", "B notu", "note");
      await ctx.writes.link(ctx.owner, {
        space_id: ctx.space.id,
        note_id: "edge-a",
        relation: "SUPPORTS",
        target_note_id: "edge-b",
        expected_revision: 1,
      });
      await ctx.writes.link(ctx.owner, {
        space_id: ctx.space.id,
        note_id: "edge-b",
        relation: "ABOUT",
        target_note_id: "edge-a",
        expected_revision: 1,
      });
      const before = await ctx.storage.db
        .selectFrom("memory_index_edges")
        .selectAll()
        .execute();
      expect(before.length).toBeGreaterThanOrEqual(2);

      await ctx.memory.archiveNote(ctx.owner, {
        spaceId: ctx.space.id,
        noteId: "edge-a",
      });

      for (const table of [
        "memory_index_terms",
        "memory_index_heads",
        "memory_index_edges",
      ] as const) {
        const rows = await ctx.storage.db
          .selectFrom(table)
          .selectAll()
          .execute();
        const touching = rows.filter(
          (row) =>
            (row as { source_note_id?: string }).source_note_id === "edge-a" ||
            (row as { target_note_id?: string }).target_note_id === "edge-a" ||
            (row as { note_id?: string }).note_id === "edge-a",
        );
        expect(touching).toEqual([]);
      }
      const bHeads = await ctx.storage.db
        .selectFrom("memory_index_heads")
        .selectAll()
        .where("note_id", "=", "edge-b")
        .execute();
      expect(bHeads).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  test(`[${backend}] purge commits the receipt before touching files and retries cleanup`, async () => {
    const ctx = await setup(backend);
    try {
      const receipt = await ctx.seed("order-note", "Sıra notu");
      const revision = await ctx.storage.db
        .selectFrom("memory_note_revisions")
        .select(["file_path"])
        .where("note_id", "=", "order-note")
        .where("revision", "=", receipt.revision)
        .executeTakeFirstOrThrow();
      const file = join(vaultRoot(ctx.root), revision.file_path!);
      await unlink(file);
      await mkdir(file);
      const retention = new MemoryRetentionService({
        db: ctx.storage.db,
        vaultRoot: vaultRoot(ctx.root),
        settings: defaultSettings,
      });
      const purged = await retention.purgeNote(ctx.owner, {
        spaceId: ctx.space.id,
        noteId: "order-note",
        reason: "sıra testi",
      });
      expect(purged.status).toBe("purged");
      expect(purged.cleanup_pending).toBe(true);
      expect(purged.files_deleted).toBe(0);
      expect(
        await ctx.storage.db
          .selectFrom("memory_notes")
          .selectAll()
          .where("id", "=", "order-note")
          .execute(),
      ).toHaveLength(0);
      const pending = await ctx.storage.db
        .selectFrom("memory_purges")
        .selectAll()
        .where("note_id", "=", "order-note")
        .executeTakeFirstOrThrow();
      expect(pending.cleanup_pending).toBe(1);
      expect(pending.file_paths_json).toContain(revision.file_path!);

      await rm(file, { recursive: true, force: true });
      const retry = new MemoryRetentionService({
        db: ctx.storage.db,
        vaultRoot: vaultRoot(ctx.root),
        settings: defaultSettings,
        now: () => Date.now() + 60_000,
      });
      const report = await retry.run();
      expect(report.purge_files_cleaned).toBeGreaterThanOrEqual(1);
      expect(report.purges_pending_cleanup).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test(`[${backend}] millisecond timestamps persist in purge, run and restore receipts`, async () => {
    const ctx = await setup(backend);
    try {
      await ctx.seed("ts-note", "Zaman notu");
      const retention = new MemoryRetentionService({
        db: ctx.storage.db,
        vaultRoot: vaultRoot(ctx.root),
        settings: defaultSettings,
      });
      const report = await retention.run();
      expect(report.purge_files_cleaned).toBe(0);
      const purged = await retention.purgeNote(ctx.owner, {
        spaceId: ctx.space.id,
        noteId: "ts-note",
        reason: "zaman testi",
      });
      expect(purged.purged_at).toBeGreaterThan(2_147_483_647);
      const purge = await ctx.storage.db
        .selectFrom("memory_purges")
        .selectAll()
        .where("note_id", "=", "ts-note")
        .executeTakeFirstOrThrow();
      expect(Number(purge.purged_at)).toBeGreaterThan(2_147_483_647);
      const run = await ctx.storage.db
        .selectFrom("memory_retention_runs")
        .selectAll()
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirstOrThrow();
      expect(Number(run.started_at)).toBeGreaterThan(2_147_483_647);
      expect(Number(run.finished_at)).toBeGreaterThanOrEqual(
        Number(run.started_at),
      );
      await recordRestoreReceipt(ctx.storage.db, {
        backend,
        manifestCreatedAt: new Date().toISOString(),
        purgesIncluded: true,
        purgesApplied: 1,
      });
      const receipt = await ctx.storage.db
        .selectFrom("memory_restore_receipts")
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirstOrThrow();
      expect(Number(receipt.created_at)).toBeGreaterThan(2_147_483_647);
      const status = await retention.restoreStatus();
      expect(status.reconciliation_required).toBe(false);
    } finally {
      await ctx.close();
    }
  });
}

test("[sqlite] curator auto-apply writes the generated note_id onto the change row", async () => {
  const fixture = await setupCurator();
  const script = [
    toolMessage([
      {
        name: "propose_patch",
        args: {
          operation: "create",
          kind: "preference",
          title: "Koyu tema",
          body: "Kullanıcı koyu temayı tercih ediyor.",
          rationale: "Kullanıcı beyanı.",
          source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
          claim: { user_declared: true },
        },
      },
    ]),
    toolMessage([
      { name: "finalize", args: { outcome: "proposed", reason: "aday" } },
    ]),
  ];
  try {
    const accepted = await fixture.accept(
      {
        space_id: fixture.spaceId,
        source_refs: [{ source_id: fixture.sourceId, path: "prefs.md" }],
      },
      "fix-apply-note-id",
    );
    const claimed = await fixture.queue.claim(
      "fix-worker",
      15000,
      "memory_curate",
    );
    const outcome = await fixture.handler(scriptedStream(script))(
      claimed!,
      new AbortController().signal,
    );
    expect(outcome.state).toBe("completed");
    const change = await fixture.storage.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .where("run_id", "=", accepted.run.id)
      .executeTakeFirstOrThrow();
    expect(change.state).toBe("applied");
    expect(change.note_id).toBeTruthy();
    const note = await fixture.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("id", "=", change.note_id!)
      .executeTakeFirst();
    expect(note).toBeTruthy();
  } finally {
    await fixture.close();
  }
});

test("[sqlite] fix #4 is not applicable on this branch: review.ts absent", async () => {
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(import.meta.dir, "..", "src/memory/review.ts"))).toBe(
    false,
  );
  // The canonical write path here is writes.ts; there is no second body
  // normalizer to reconcile. The finding targets a file from another branch.
  expect(ForgeError).toBeDefined();
});
