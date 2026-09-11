import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryContextService } from "../src/memory/context.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryWriteService } from "../src/memory/writes.js";
import {
  parseMemoryDocument,
  serializeMemoryDocument,
} from "../src/domain/memory.js";
import { sha256Hex } from "../src/memory/files.js";
import { resolveVaultRelative, vaultRoot } from "../src/memory/paths.js";

/**
 * Integration-round defect fixes (TDD): lossless typed edits, operation-level
 * event_key idempotency, SUPERSEDES target lifecycle, and the whole-package
 * context budget invariant. These mirror the independent verification
 * contracts without touching those files.
 */

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-m03-fixes-"));
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const vault = vaultRoot(root);
  const service = new MemoryService(storage.db, identities, vault);
  const index = new MemoryIndexService(storage.db, vault, service);
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: vault,
    service,
    index,
  });
  const writes = new MemoryWriteService({
    db: storage.db,
    service,
    commits,
    vaultRoot: vault,
  });
  const context = new MemoryContextService(storage.db, service);
  const space = await service.ensureSpace(owner, { type: "personal" });
  const createNote = async (input: {
    noteId?: string;
    kind?: string;
    title: string;
    body?: string;
    taskStatus?: string | null;
    extraFrontmatter?: string;
    sources?: string;
    validFrom?: number;
    validUntil?: number;
  }) => {
    const noteId = input.noteId ?? crypto.randomUUID();
    const content = [
      "---",
      "format_version: 1",
      `note_id: ${JSON.stringify(noteId)}`,
      `memory_space_id: ${JSON.stringify(space.id)}`,
      `kind: ${input.kind ?? "note"}`,
      `title: ${JSON.stringify(input.title)}`,
      ...(input.taskStatus
        ? [`task_status: ${JSON.stringify(input.taskStatus)}`]
        : []),
      ...(input.sources ? [`sources: ${input.sources}`] : []),
      ...(input.validFrom !== undefined
        ? [`valid_from: ${input.validFrom}`]
        : []),
      ...(input.validUntil !== undefined
        ? [`valid_until: ${input.validUntil}`]
        : []),
      ...(input.extraFrontmatter ? [input.extraFrontmatter] : []),
      "---",
      "",
      input.body ?? "gövde",
      "",
    ].join("\n");
    const event = await service.recordEvent(owner, {
      spaceId: space.id,
      sourceEventKey: `fix:${noteId}`,
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    await commits.commit({
      identity: owner,
      spaceId: space.id,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
      noteId,
    });
    return { noteId, content };
  };
  const recordOf = async (noteId: string) => {
    const note = await storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("id", "=", noteId)
      .executeTakeFirstOrThrow();
    const row = await storage.db
      .selectFrom("memory_note_revisions")
      .selectAll()
      .where("note_id", "=", noteId)
      .where("revision", "=", note.current_revision!)
      .executeTakeFirstOrThrow();
    const text = await Bun.file(
      resolveVaultRelative(vault, row.file_path!),
    ).text();
    const parsed = parseMemoryDocument(text);
    if (parsed.status !== "ok") throw new Error("record parse failed");
    return { note, record: parsed.record };
  };
  return {
    root,
    storage,
    owner,
    space,
    service,
    commits,
    writes,
    context,
    createNote,
    recordOf,
    close: async () => {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("#36 fix-1 typed patch preserves sources, unknown frontmatter and validity", async () => {
  const env = await fixture();
  try {
    const noteId = "lossy-note";
    const { content } = await env.createNote({
      noteId,
      title: "Kaynaklı not",
      body: "ilk gövde",
      sources: `[{"id":"agz-1","kind":"agz","hash":"${"a".repeat(64)}"}]`,
      validFrom: 1000,
      validUntil: 2000,
      extraFrontmatter: 'custom_field: "korunmalı"',
    });
    expect(parseMemoryDocument(content).status).toBe("ok");
    await env.writes.update(env.owner, {
      space_id: env.space.id,
      note_id: noteId,
      expected_revision: 1,
      body: "yeni gövde",
    } as never);
    const after = await env.recordOf(noteId);
    expect(after.record.sources).toHaveLength(1);
    expect(after.record.unknown.custom_field).toBe("korunmalı");
    expect(after.record.validFrom).toBe(1000);
    expect(after.record.validUntil).toBe(2000);
    expect(after.record.body).toContain("yeni gövde");
    expect(after.note.current_revision).toBe(2);
  } finally {
    await env.close();
  }
});

test("#36 fix-3 same event_key + same content completes pending event; different content is 409", async () => {
  const env = await fixture();
  try {
    const { noteId } = await env.createNote({
      noteId: "retry-note",
      title: "Retry notu",
      body: "ilk gövde",
    });
    // Crash/timeout senaryosu: ilk deneme olayı kaydetmiş ama commit
    // tamamlanmamış. Aynı istek (aynı anahtar + aynı içerik) yeniden gelir.
    const before = await env.recordOf(noteId);
    const pendingContent = serializeMemoryDocument({
      ...before.record,
      body: "v2",
      baseRevision: before.note.current_revision,
      revision: before.note.current_revision,
    });
    await env.service.recordEvent(env.owner, {
      spaceId: env.space.id,
      sourceEventKey: "pending-key",
      sourceKind: "manual",
      contentHash: sha256Hex(pendingContent),
    });
    const committed = await env.writes.update(env.owner, {
      space_id: env.space.id,
      note_id: noteId,
      expected_revision: 1,
      body: "v2",
      event_key: "pending-key",
    } as never);
    expect(Number(committed.revision)).toBe(2);
    // Aynı anahtar + FARKLI içerik: M02 kaynak-olay çakışması 409.
    await expect(
      env.writes.update(env.owner, {
        space_id: env.space.id,
        note_id: noteId,
        expected_revision: 2,
        body: "v3",
        event_key: "pending-key",
      } as never),
    ).rejects.toMatchObject({ code: "memory_event_conflict", status: 409 });
    const after = await env.recordOf(noteId);
    expect(after.note.current_revision).toBe(2);
    expect(after.record.body).toContain("v2");
  } finally {
    await env.close();
  }
});

test("#36 fix-4 SUPERSEDES A→B marks B superseded while A stays active", async () => {
  const env = await fixture();
  try {
    const old = await env.createNote({
      noteId: "old-note",
      kind: "decision",
      title: "Eski karar",
    });
    const next = await env.createNote({
      noteId: "next-note",
      kind: "decision",
      title: "Yeni karar",
    });
    await env.writes.update(env.owner, {
      space_id: env.space.id,
      note_id: next.noteId,
      expected_revision: 1,
      supersede_target: old.noteId,
    } as never);
    const updated = await env.recordOf(next.noteId);
    expect(
      updated.record.edges.some(
        (edge) => edge.relation === "SUPERSEDES" && edge.target === old.noteId,
      ),
    ).toBe(true);
    expect(updated.record.lifecycle).toBe("active");
    const oldNote = await env.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("id", "=", old.noteId)
      .executeTakeFirstOrThrow();
    expect(oldNote.lifecycle).toBe("superseded");
    expect(oldNote.superseded_by).toBe(next.noteId);
  } finally {
    await env.close();
  }
});

test("#36 fix-2 whole-package context budget holds at max_tokens=128", async () => {
  const env = await fixture();
  try {
    // 25 aktif görev + 1 engel + 5 karar: bölümler tek başına bütçeyi aşamaz.
    for (let index = 0; index < 25; index += 1)
      await env.createNote({
        noteId: `budget-task-${index}`,
        kind: "task",
        title: `Görev ${index}`,
        body: `Gövde ${index}`,
        taskStatus: index === 24 ? "blocked" : "doing",
      });
    for (let index = 0; index < 5; index += 1)
      await env.createNote({
        noteId: `budget-decision-${index}`,
        kind: "decision",
        title: `Karar ${index}`,
        body: `Karar gövdesi ${index}`,
      });
    const pkg = await env.context.context(env.owner, { maxTokens: 128 });
    expect(pkg.envelope.budget.used_tokens_estimate).toBeLessThanOrEqual(
      pkg.envelope.budget.max_tokens,
    );
    // Öncelik: engel ve devam adımı korunur.
    expect(pkg.sections.blockers).toContain("budget-task-24");
    expect(pkg.sections.continuation).not.toBeNull();
    expect(pkg.truncated).toBe(true);
  } finally {
    await env.close();
  }
});
