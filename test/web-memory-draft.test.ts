import { describe, expect, test } from "bun:test";
import {
  clearMemorySnapshot,
  draftDirty,
  emptyMemorySnapshot,
  findDraftForNote,
  memoryDraftIdentity,
  memoryScopeKey,
  noteIdOfDraftKey,
  pendingCount,
  pendingForNote,
  readMemorySnapshot,
  unpublishedWork,
  writeMemorySnapshot,
  type MemoryDraft,
  type MemoryDraftSnapshot,
  type MemoryPendingSave,
} from "../web/src/memory/drafts.js";

function draft(
  noteId: string,
  title: string,
  baseRevision: number,
): MemoryDraft {
  return {
    noteId,
    title,
    summary: "",
    body: "gövde",
    kind: "note",
    baseRevision,
    server: {
      title: "sunucu",
      summary: "",
      body: "gövde",
      kind: "note",
      revision: baseRevision,
    },
    updatedAt: 1,
  };
}

function pending(
  eventKey: string,
  noteId: string,
  status: MemoryPendingSave["status"],
): MemoryPendingSave {
  return {
    eventKey,
    runId: `run-${eventKey}`,
    noteId,
    baseRevision: 1,
    submitted: { title: "t", summary: "", body: "b", document: "d" },
    status,
    indexed: false,
    errorCode: null,
    committedRevision: null,
    updatedAt: 1,
  };
}

describe("issue #37 memory draft scope keys", () => {
  test("tenant and space separate the scope", () => {
    const a = memoryScopeKey("tenant-a", "space-1");
    const b = memoryScopeKey("tenant-b", "space-1");
    const c = memoryScopeKey("tenant-a", "space-2");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("draft identity includes note and base revision", () => {
    const key = memoryDraftIdentity("tenant-a", "space-1", "note-1", 3);
    expect(key).toContain("note-1");
    expect(key).toContain("3");
    expect(noteIdOfDraftKey(key)).toBe("note-1");
    const other = memoryDraftIdentity("tenant-a", "space-1", "note-1", 4);
    expect(other).not.toBe(key);
  });

  test("a stored snapshot is readable only through its own scope", () => {
    const key = memoryScopeKey("tenant-a", "space-1");
    const other = memoryScopeKey("tenant-b", "space-1");
    const snapshot = emptyMemorySnapshot();
    const identity = memoryDraftIdentity("tenant-a", "space-1", "note-1", 1);
    snapshot.drafts[identity] = draft("note-1", "taslak", 1);
    try {
      writeMemorySnapshot(key, snapshot);
      expect(findDraftForNote(readMemorySnapshot(key)!, "note-1")?.title).toBe(
        "taslak",
      );
      expect(readMemorySnapshot(other)).toBeNull();
      // Reads return copies; mutating them cannot corrupt the store.
      const copy = readMemorySnapshot(key)!;
      copy.drafts[identity]!.title = "değişti";
      expect(findDraftForNote(readMemorySnapshot(key)!, "note-1")?.title).toBe(
        "taslak",
      );
    } finally {
      clearMemorySnapshot(key);
      clearMemorySnapshot(other);
    }
  });

  test("an empty snapshot is not stored", () => {
    const key = memoryScopeKey("t", "s");
    writeMemorySnapshot(key, emptyMemorySnapshot());
    expect(readMemorySnapshot(key)).toBeNull();
  });
});

describe("issue #37 dirty and unpublished work", () => {
  test("fields equal to the server baseline are not dirty", () => {
    const value = draft("note-1", "sunucu", 1);
    value.body = "gövde";
    expect(draftDirty(value)).toBe(false);
  });

  test("title, summary or body changes count as dirty", () => {
    expect(draftDirty(draft("note-1", "yeni", 1))).toBe(true);
    const summary = draft("note-1", "sunucu", 1);
    summary.summary = "ek";
    expect(draftDirty(summary)).toBe(true);
    const body = draft("note-1", "sunucu", 1);
    body.body = "değişti";
    expect(draftDirty(body)).toBe(true);
  });

  test("a queued or rejected candidate counts even without editor text", () => {
    const snapshot: MemoryDraftSnapshot = emptyMemorySnapshot();
    snapshot.pending["evt-1"] = pending("evt-1", "note-1", "queued");
    expect(unpublishedWork(snapshot)).toBe(true);
    snapshot.pending["evt-1"]!.status = "rejected";
    expect(unpublishedWork(snapshot)).toBe(true);
    snapshot.pending["evt-1"]!.status = "committed";
    expect(unpublishedWork(snapshot)).toBe(false);
  });

  test("a draft on another note still counts as unpublished work", () => {
    const snapshot: MemoryDraftSnapshot = emptyMemorySnapshot();
    const identity = memoryDraftIdentity("t", "s", "note-2", 1);
    snapshot.drafts[identity] = draft("note-2", "başka not", 1);
    expect(unpublishedWork(snapshot)).toBe(true);
    expect(findDraftForNote(snapshot, "note-1")).toBeNull();
    expect(findDraftForNote(snapshot, "note-2")?.noteId).toBe("note-2");
  });

  test("pending helpers are note scoped and count only open work", () => {
    const snapshot: MemoryDraftSnapshot = emptyMemorySnapshot();
    snapshot.pending["evt-1"] = pending("evt-1", "note-1", "queued");
    snapshot.pending["evt-2"] = pending("evt-2", "note-1", "committed");
    snapshot.pending["evt-3"] = pending("evt-3", "note-2", "rejected");
    expect(pendingForNote(snapshot, "note-1")).toHaveLength(2);
    expect(pendingForNote(snapshot, "note-2")).toHaveLength(1);
    expect(pendingCount(snapshot)).toBe(2);
  });
});
