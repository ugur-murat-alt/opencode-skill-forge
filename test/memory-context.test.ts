import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryContextService } from "../src/memory/context.js";
import { sha256Hex } from "../src/memory/files.js";
import { vaultRoot } from "../src/memory/paths.js";
import type { DatabaseHandle } from "../src/storage/database.js";

/**
 * Issue #36 (M03): the context compiler. Budgets, cards with
 * note_id+revision+sources, explicit truncation/continuation, offered vs
 * delivered (`known_revisions`) and freshness against the current head are
 * all exercised with real rows.
 */

async function openEnv(backend: "sqlite" | "postgres") {
  const root = await mkdtemp(join(tmpdir(), "forge-m03-context-"));
  let postgresUrl: string | undefined;
  let admin: PgClient | undefined;
  const databaseName = `forge_m03_ctx_${crypto.randomUUID().replaceAll("-", "")}`;
  if (backend === "postgres") {
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
  return {
    root,
    storage,
    cleanup: async () => {
      await storage.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface Seed {
  noteId: string;
  title: string;
  body: string;
  kind?: string;
  taskStatus?: string | null;
  pinned?: boolean;
  revision?: number;
}

async function seed(
  storage: DatabaseHandle,
  tenantId: string,
  spaceId: string,
  ownerId: string,
  notes: Seed[],
): Promise<void> {
  const now = Date.now();
  for (const note of notes) {
    await storage.db
      .insertInto("memory_notes")
      .values({
        tenant_id: tenantId,
        space_id: spaceId,
        id: note.noteId,
        lifecycle: "active",
        pinned: note.pinned ? 1 : 0,
        task_status: (note.taskStatus ?? null) as never,
        current_revision: note.revision ?? 1,
        format_version: 1,
        title: note.title,
        summary: null,
        created_at: now,
        updated_at: now,
        superseded_by: null,
        source_id: null,
        source_path: null,
        source_hash: null,
        source_state: "present",
        deleted_at: null,
      })
      .execute();
    await storage.db
      .insertInto("memory_note_revisions")
      .values({
        tenant_id: tenantId,
        space_id: spaceId,
        note_id: note.noteId,
        revision: note.revision ?? 1,
        format_version: 1,
        kind: note.kind ?? "note",
        title: note.title,
        summary: null,
        body_md: note.body,
        metadata_json: JSON.stringify({
          record_hash: "",
          record: {
            kind: note.kind ?? "note",
            title: note.title,
            summary: null,
            lifecycle: "active",
            pinned: note.pinned ?? false,
            task_status: note.taskStatus ?? null,
            verification: "declared",
            sources: [{ id: `src:${note.noteId}`, kind: "manual" }],
            edges: [],
          },
        }),
        sources_json: JSON.stringify([{ id: `src:${note.noteId}` }]),
        base_revision: null,
        created_by: ownerId,
        created_at: now,
        file_path: null,
        content_hash: sha256Hex(note.body),
        byte_size: note.body.length,
      })
      .execute();
  }
}

async function fixture(backend: "sqlite" | "postgres") {
  const env = await openEnv(backend);
  const identities = new IdentityService(env.storage.db);
  const owner = await identities.bootstrapLocal();
  const service = new MemoryService(
    env.storage.db,
    identities,
    vaultRoot(env.root),
  );
  const space = await service.ensureSpace(owner, { type: "personal" });
  const index = new MemoryIndexService(
    env.storage.db,
    vaultRoot(env.root),
    service,
  );
  const context = new MemoryContextService(env.storage.db, service);
  return { env, storage: env.storage, owner, service, space, index, context };
}

for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
] as const) {
  test(`#36 context compiles sourced cards, sections and a continuation step (${backend})`, async () => {
    const { env, storage, owner, space, index, context } =
      await fixture(backend);
    try {
      await seed(storage, owner.tenantId, space.id, owner.userId, [
        {
          noteId: "task-doing",
          title: "Aktif görev",
          body: "ilerleme devam ediyor",
          kind: "task",
          taskStatus: "doing",
        },
        {
          noteId: "task-blocked",
          title: "Engelli görev",
          body: "engel: dış onay",
          kind: "task",
          taskStatus: "blocked",
        },
        {
          noteId: "decision-1",
          title: "Son karar",
          body: "karar gövdesi",
          kind: "decision",
        },
        {
          noteId: "pin-1",
          title: "Sabit not",
          body: "pin gövdesi",
          pinned: true,
        },
        {
          noteId: "session-1",
          title: "Oturum",
          body: "oturum notu",
          kind: "session",
        },
      ]);
      await index.rebuild(owner, { batchSize: 100 });
      const result = await context.context(owner, {
        spaceId: space.id,
        maxTokens: 2048,
      });
      const cardIds = result.cards.map((card) => card.note_id);
      expect(cardIds).toContain("task-blocked");
      expect(cardIds).toContain("task-doing");
      expect(cardIds).toContain("decision-1");
      expect(cardIds).toContain("pin-1");
      const blockerCard = result.cards.find(
        (card) => card.note_id === "task-blocked",
      );
      expect(blockerCard).toMatchObject({
        revision: 1,
        kind: "task",
        task_status: "blocked",
        match_reason: "blocker:task",
      });
      expect(blockerCard?.sources).toEqual([
        { id: "src:task-blocked", kind: "manual" },
      ]);
      expect(blockerCard?.snippet).toContain("engel");
      expect(result.sections.blockers).toEqual(["task-blocked"]);
      expect(result.sections.active_tasks).toEqual(["task-doing"]);
      expect(result.sections.recent_decisions).toEqual(["decision-1"]);
      expect(result.sections.pins).toEqual(["pin-1"]);
      expect(["task-doing", "task-blocked"]).toContain(
        result.sections.continuation!,
      );
      expect(result.envelope.token_estimator).toContain("estimate");
      expect(result.offered.some((item) => item.note_id === "task-doing")).toBe(
        true,
      );
    } finally {
      await env.cleanup();
    }
  }, 60_000);

  test(`#36 context budget truncates explicitly and never reports characters as tokens (${backend})`, async () => {
    const { env, storage, owner, space, index, context } =
      await fixture(backend);
    try {
      await seed(
        storage,
        owner.tenantId,
        space.id,
        owner.userId,
        Array.from({ length: 12 }, (_, index) => ({
          noteId: `pin-${index}`,
          title: `Sabit ${index}`,
          body: `${"çok uzun unicode içerik ğüşöçı ".repeat(60)} ${index}`,
          pinned: true,
        })),
      );
      await index.rebuild(owner, { batchSize: 100 });
      const result = await context.context(owner, {
        spaceId: space.id,
        maxTokens: 256,
      });
      expect(result.cards.length).toBeLessThanOrEqual(8);
      const budget = result.envelope.budget!;
      expect(budget.max_tokens).toBe(256);
      expect(budget.used_tokens_estimate).toBeLessThanOrEqual(256);
      expect(result.truncated).toBe(true);
      expect(result.continuation_note).not.toBeNull();
      expect(result.envelope.token_estimator).toContain("bytes/2.5");
    } finally {
      await env.cleanup();
    }
  }, 60_000);

  test(`#36 known_revisions produce a delta and new revisions reappear (${backend})`, async () => {
    const { env, storage, owner, space, index, context } =
      await fixture(backend);
    try {
      await seed(storage, owner.tenantId, space.id, owner.userId, [
        {
          noteId: "delta-1",
          title: "Delta",
          body: "ilk sürüm",
          kind: "decision",
        },
      ]);
      await index.rebuild(owner, { batchSize: 100 });
      const first = await context.context(owner, { spaceId: space.id });
      expect(first.offered).toHaveLength(1);
      const second = await context.context(owner, {
        spaceId: space.id,
        knownRevisions: first.offered.map((item) => ({
          note_id: item.note_id,
          revision: item.revision,
        })),
        // Aynı oturum/nesil/branch bağlamı taşınır.
        session_key: "s1",
        generation: 1,
        branch: "main",
        worktree: "wt",
      });
      expect(second.cards).toEqual([]);
      expect(second.offered).toEqual([]);
      expect(second.sections.recent_decisions).toEqual(["delta-1"]);
      // Yeni revision: delta yalnız değişeni sunar (supersession/düzeltme).
      await storage.db
        .updateTable("memory_note_revisions")
        .set({
          revision: 2,
          body_md: "ikinci sürüm",
          title: "Delta v2",
          metadata_json: JSON.stringify({
            record_hash: "",
            record: {
              kind: "decision",
              title: "Delta v2",
              summary: null,
              lifecycle: "active",
              pinned: false,
              task_status: null,
              verification: "declared",
              sources: [],
              edges: [],
            },
          }),
        })
        .where("note_id", "=", "delta-1")
        .execute();
      await storage.db
        .updateTable("memory_notes")
        .set({ current_revision: 2, title: "Delta v2" })
        .where("id", "=", "delta-1")
        .execute();
      await index.indexNote(owner.tenantId, space.id, "delta-1");
      const third = await context.context(owner, {
        spaceId: space.id,
        knownRevisions: first.offered.map((item) => ({
          note_id: item.note_id,
          revision: item.revision,
        })),
      });
      expect(third.offered).toEqual([
        { note_id: "delta-1", revision: 2, content_hash: expect.any(String) },
      ]);
      expect(third.cards[0]?.revision).toBe(2);
      expect(third.cards[0]?.title).toBe("Delta v2");
    } finally {
      await env.cleanup();
    }
  }, 60_000);

  test(`#36 an empty authorized snapshot returns no filler cards (${backend})`, async () => {
    const { env, owner, space, context } = await fixture(backend);
    try {
      const result = await context.context(owner, { spaceId: space.id });
      expect(result.cards).toEqual([]);
      expect(result.offered).toEqual([]);
      expect(result.truncated).toBe(false);
      expect(result.sections.continuation).toBeNull();
    } finally {
      await env.cleanup();
    }
  }, 30_000);
}
