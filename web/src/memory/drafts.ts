/**
 * Issue #37 (M04) phase A: tenant+space+note+base_revision scoped drafts.
 * The store mirrors the #31 package-draft pattern: a module map survives
 * unmounting, sessionStorage survives a tab refresh, and the visible tenant
 * is part of every key so a draft can never leak into another scope.
 */

export interface MemoryDraftServerState {
  title: string;
  summary: string;
  body: string;
  kind: string;
  revision: number | null;
}

export interface MemoryDraft {
  noteId: string;
  title: string;
  summary: string;
  body: string;
  kind: string;
  /** Revision the draft was based on; null while the note is not committed. */
  baseRevision: number | null;
  /** Server state the draft started from (dirty baseline). */
  server: MemoryDraftServerState;
  updatedAt: number;
}

export interface MemoryPendingSave {
  eventKey: string;
  runId: string;
  noteId: string;
  baseRevision: number | null;
  submitted: {
    title: string;
    summary: string;
    body: string;
    document: string;
  };
  status: "queued" | "committed" | "rejected";
  indexed: boolean;
  errorCode: string | null;
  committedRevision: number | null;
  updatedAt: number;
}

export interface MemoryDraftSnapshot {
  drafts: Record<string, MemoryDraft>;
  pending: Record<string, MemoryPendingSave>;
}

export const MAX_PERSISTED_BYTES = 256 * 1024;
const DRAFT_STORAGE_PREFIX = "forge-memory-draft:";
const RECENT_STORAGE_PREFIX = "forge-memory-recent:";
const MAX_RECENT = 8;

const snapshots = new Map<string, MemoryDraftSnapshot>();

export function emptyMemorySnapshot(): MemoryDraftSnapshot {
  return { drafts: {}, pending: {} };
}

/** Scope identifies one tenant + space workspace. */
export function memoryScopeKey(tenantId: string, spaceId: string): string {
  return `${tenantId}\u0000${spaceId}`;
}

/** Full draft identity including the base revision it was created against. */
export function memoryDraftIdentity(
  tenantId: string,
  spaceId: string,
  noteId: string,
  baseRevision: number | null,
): string {
  return `${memoryScopeKey(tenantId, spaceId)}\u0000${noteId}\u0000${baseRevision ?? "new"}`;
}

export function noteIdOfDraftKey(key: string): string {
  const parts = key.split("\u0000");
  return parts[2] ?? key;
}

export function findDraftForNote(
  snapshot: Pick<MemoryDraftSnapshot, "drafts">,
  noteId: string,
): MemoryDraft | null {
  for (const draft of Object.values(snapshot.drafts))
    if (draft.noteId === noteId) return draft;
  return null;
}

export function pendingForNote(
  snapshot: Pick<MemoryDraftSnapshot, "pending">,
  noteId: string,
): MemoryPendingSave[] {
  return Object.values(snapshot.pending).filter(
    (pending) => pending.noteId === noteId,
  );
}

export function draftDirty(draft: MemoryDraft): boolean {
  return (
    draft.title !== draft.server.title ||
    draft.summary !== draft.server.summary ||
    draft.body !== draft.server.body
  );
}

/**
 * Any unpublished work counts: unsent editor text, a queued/durable candidate
 * that has not committed, or a rejected candidate awaiting a decision.
 */
export function unpublishedWork(
  snapshot: Pick<MemoryDraftSnapshot, "drafts" | "pending">,
): boolean {
  if (Object.values(snapshot.drafts).some(draftDirty)) return true;
  return Object.values(snapshot.pending).some(
    (pending) => pending.status !== "committed",
  );
}

export function pendingCount(
  snapshot: Pick<MemoryDraftSnapshot, "pending">,
): number {
  return Object.values(snapshot.pending).filter(
    (pending) => pending.status !== "committed",
  ).length;
}

function copySnapshot(snapshot: MemoryDraftSnapshot): MemoryDraftSnapshot {
  return {
    drafts: Object.fromEntries(
      Object.entries(snapshot.drafts).map(([key, draft]) => [
        key,
        { ...draft, server: { ...draft.server } },
      ]),
    ),
    pending: Object.fromEntries(
      Object.entries(snapshot.pending).map(([key, pending]) => [
        key,
        { ...pending, submitted: { ...pending.submitted } },
      ]),
    ),
  };
}

function loadPersisted(key: string): MemoryDraftSnapshot | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`${DRAFT_STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MemoryDraftSnapshot>;
    return {
      drafts: parsed.drafts ?? {},
      pending: parsed.pending ?? {},
    };
  } catch {
    return null;
  }
}

function persist(key: string, snapshot: MemoryDraftSnapshot): void {
  if (typeof sessionStorage === "undefined") return;
  const storageKey = `${DRAFT_STORAGE_PREFIX}${key}`;
  try {
    const raw = JSON.stringify(snapshot);
    if (raw.length > MAX_PERSISTED_BYTES) {
      sessionStorage.removeItem(storageKey);
      return;
    }
    sessionStorage.setItem(storageKey, raw);
  } catch {}
}

export function readMemorySnapshot(key: string): MemoryDraftSnapshot | null {
  let snapshot = snapshots.get(key);
  if (!snapshot) {
    const persisted = loadPersisted(key);
    if (persisted) {
      snapshots.set(key, persisted);
      snapshot = persisted;
    }
  }
  return snapshot ? copySnapshot(snapshot) : null;
}

export function writeMemorySnapshot(
  key: string,
  snapshot: MemoryDraftSnapshot,
): void {
  if (
    Object.keys(snapshot.drafts).length === 0 &&
    Object.keys(snapshot.pending).length === 0
  ) {
    snapshots.delete(key);
    if (typeof sessionStorage !== "undefined")
      try {
        sessionStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${key}`);
      } catch {}
    return;
  }
  snapshots.set(key, copySnapshot(snapshot));
  persist(key, snapshot);
}

export function clearMemorySnapshot(key: string): void {
  snapshots.delete(key);
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${key}`);
  } catch {}
}

// --- Recently opened notes (client-side navigation convenience) -------------

export function rememberRecentNote(
  tenantId: string,
  spaceId: string,
  noteId: string,
): void {
  if (typeof localStorage === "undefined") return;
  const key = `${RECENT_STORAGE_PREFIX}${memoryScopeKey(tenantId, spaceId)}`;
  try {
    const current = readRecentNotes(tenantId, spaceId).filter(
      (id) => id !== noteId,
    );
    localStorage.setItem(
      key,
      JSON.stringify([noteId, ...current].slice(0, MAX_RECENT)),
    );
  } catch {}
}

export function readRecentNotes(tenantId: string, spaceId: string): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(
      `${RECENT_STORAGE_PREFIX}${memoryScopeKey(tenantId, spaceId)}`,
    );
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}
