import { ApiError, api } from "../api";

/**
 * Issue #37 (M04) phase A: typed client for the real M02 HTTP surface. Only
 * endpoints that exist in `src/http/server.ts` are called here; graph,
 * context, checkpoint and search stay in phase B.
 */

export type MemorySpaceKind = "personal" | "project" | "organization";

export interface MemorySpace {
  id: string;
  kind: MemorySpaceKind;
  name: string;
  project_id: string | null;
  owner_user_id: string;
  created_at: number;
  updated_at: number;
  scope: { type: string; projectId?: string };
}

export interface MemoryNote {
  tenant_id: string;
  space_id: string;
  id: string;
  lifecycle: string;
  pinned: number;
  task_status: string | null;
  current_revision: number | null;
  format_version: number;
  title: string;
  summary: string | null;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
  source_id: string | null;
  source_path: string | null;
  source_hash: string | null;
  source_state: string;
  deleted_at: number | null;
  display_path: string;
}

export interface MemoryNoteList {
  space: { id: string; kind: MemorySpaceKind; name: string };
  items: MemoryNote[];
  next: string | null;
}

export interface MemoryRevision {
  revision: number;
  format_version: number;
  kind: string;
  title: string;
  summary: string | null;
  base_revision: number | null;
  created_by: string;
  created_at: number;
  content_hash: string | null;
  byte_size: number | null;
  /** Present on the note detail revision; not on the history list. */
  sources_json?: string;
}

export interface MemoryNoteDetail {
  note: MemoryNote;
  revision: MemoryRevision | null;
  content: string | null;
  display_path: string;
}

export interface MemoryRevisionDetail {
  revision: MemoryRevision;
  content: string | null;
}

export interface MemoryRevisionPage {
  items: MemoryRevision[];
  next: number | null;
}

export interface MemoryCandidate {
  id: string;
  source_id: string | null;
  path: string;
  note_id: string | null;
  previous_hash: string | null;
  observed_hash: string | null;
  base_revision: number | null;
  state: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemorySourceRow {
  id: string;
  space_id: string;
  root_path: string;
  mode: "read_only" | "managed";
  status: string;
  last_scan_at: number | null;
}

export interface MemoryReceipt {
  event_id: string;
  state: "pending" | "committed" | "rejected";
  indexed: boolean;
  committed_revision: number | null;
  error_code: string | null;
  /** Live run state; a failed run reports the durable worker error. */
  run_state: string | null;
  run_error_code: string | null;
  receipt: {
    noteId: string;
    revision: number;
    recordHash: string;
    fileHash: string;
    filePath: string;
    byteSize: number;
    redacted: boolean;
    indexed: boolean;
  } | null;
}

export interface MemoryIngestResult {
  status: "accepted" | "duplicate";
  run_id: string;
  run_state: string;
}

export async function memorySpaces(): Promise<{
  items: MemorySpace[];
  next: string | null;
}> {
  return api("/api/memory/spaces");
}

export async function ensureMemorySpace(input: {
  kind: MemorySpaceKind;
  projectId?: string;
  name?: string;
}): Promise<MemorySpace> {
  return api("/api/memory/spaces", {
    method: "POST",
    body: JSON.stringify({
      kind: input.kind,
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.name ? { name: input.name } : {}),
    }),
  });
}

export async function memoryNotes(
  spaceId: string,
  options: { after?: string; limit?: number } = {},
): Promise<MemoryNoteList> {
  const query = new URLSearchParams({ space_id: spaceId });
  if (options.after) query.set("after", options.after);
  if (options.limit) query.set("limit", String(options.limit));
  return api(`/api/memory/notes?${query.toString()}`);
}

export async function memoryNote(
  spaceId: string,
  noteId: string,
): Promise<MemoryNoteDetail> {
  const query = new URLSearchParams({ space_id: spaceId });
  return api(
    `/api/memory/notes/${encodeURIComponent(noteId)}?${query.toString()}`,
  );
}

export async function memoryRevisions(
  spaceId: string,
  noteId: string,
  options: { after?: number; limit?: number } = {},
): Promise<MemoryRevisionPage> {
  const query = new URLSearchParams({ space_id: spaceId });
  if (options.after !== undefined) query.set("after", String(options.after));
  if (options.limit) query.set("limit", String(options.limit));
  return api(
    `/api/memory/notes/${encodeURIComponent(noteId)}/revisions?${query.toString()}`,
  );
}

export async function memoryRevision(
  spaceId: string,
  noteId: string,
  revision: number,
): Promise<MemoryRevisionDetail> {
  const query = new URLSearchParams({ space_id: spaceId });
  return api(
    `/api/memory/notes/${encodeURIComponent(noteId)}/revisions/${revision}?${query.toString()}`,
  );
}

export async function memoryConflicts(
  spaceId: string,
  noteId?: string,
): Promise<{ items: MemoryCandidate[]; next: string | null }> {
  const query = new URLSearchParams({ space_id: spaceId });
  if (noteId) query.set("note_id", noteId);
  return api(`/api/memory/conflicts?${query.toString()}`);
}

export async function memorySources(
  spaceId: string,
): Promise<{ items: MemorySourceRow[] }> {
  const query = new URLSearchParams({ space_id: spaceId });
  return api(`/api/memory/sources?${query.toString()}`);
}

export async function memoryIngest(input: {
  spaceId: string;
  eventKey: string;
  sourceKind: string;
  content: string;
  noteId?: string;
  baseRevision?: number | null;
}): Promise<MemoryIngestResult> {
  return api("/api/memory/ingest", {
    method: "POST",
    body: JSON.stringify({
      space_id: input.spaceId,
      source_event_key: input.eventKey,
      source_kind: input.sourceKind,
      content: input.content,
      ...(input.noteId ? { note_id: input.noteId } : {}),
      ...(input.baseRevision !== undefined && input.baseRevision !== null
        ? { base_revision: input.baseRevision }
        : {}),
    }),
  });
}

/** Receipt polling; a 404 means the worker has not recorded the event yet. */
export async function memoryReceipt(
  spaceId: string,
  eventKey: string,
): Promise<MemoryReceipt | null> {
  const query = new URLSearchParams({
    space_id: spaceId,
    source_event_key: eventKey,
  });
  try {
    return await api(`/api/memory/events?${query.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function memoryArchive(
  spaceId: string,
  noteId: string,
): Promise<{ noteId: string; deleted_at: number | null }> {
  return api(`/api/memory/notes/${encodeURIComponent(noteId)}/archive`, {
    method: "POST",
    body: JSON.stringify({ space_id: spaceId }),
  });
}

export async function memoryRestore(
  spaceId: string,
  noteId: string,
): Promise<{ noteId: string; deleted_at: number | null }> {
  return api(`/api/memory/notes/${encodeURIComponent(noteId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ space_id: spaceId }),
  });
}

/** True for the async revision conflict the commit worker reports. */
export function isRevisionConflict(errorCode: string | null): boolean {
  return errorCode === "memory_revision_conflict";
}
