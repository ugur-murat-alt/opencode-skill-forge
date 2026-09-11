import { ApiError, api, errorCode } from "../api";

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

// --- Phase B (M03): recall, graph, context, writes, tasks, health ----------

export interface MemoryGraphNode {
  note_id: string;
  space_id: string;
  revision: number;
  title: string;
  kind: string;
  depth: number;
  pinned: boolean;
}

export interface MemoryGraphEdge {
  source_note_id: string;
  relation: string;
  target_note_id: string;
}

export interface MemoryGraph {
  origin: { note_id: string; space_id: string; revision: number };
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  truncated: boolean;
}

export interface MemorySearchCard {
  note_id: string;
  space_id: string;
  revision: number;
  current_revision: number;
  title: string;
  kind: string;
  snippet: string;
  score: number;
  match_reason: string[];
  lifecycle: string;
  pinned: boolean;
  verification: string;
  sources: unknown[];
  stale: boolean;
}

export interface MemoryRecallPage {
  items: MemorySearchCard[];
  next: string | null;
  index: { stale: number; pending_events: number; indexed_at: number | null };
}

export interface MemoryContextCard {
  note_id: string;
  space_id: string;
  revision: number;
  kind: string;
  title: string;
  snippet: string;
  match_reason: string;
  sources: unknown[];
  verification: string;
  pinned: boolean;
  task_status: string | null;
  lifecycle: string;
  token_estimate: number;
}

export interface MemoryContextPackage {
  envelope: {
    version: number;
    generated_at: number;
    session_key: string | null;
    generation: number | null;
    branch: string | null;
    worktree: string | null;
    package_hash: string;
    token_estimator: string;
  };
  cards: MemoryContextCard[];
  sections: {
    active_tasks: string[];
    blockers: string[];
    recent_decisions: string[];
    pins: string[];
    continuation: string | null;
  };
  truncated: boolean;
  continuation_note: { note_id: string; revision: number } | null;
  offered: { note_id: string; revision: number; content_hash: string }[];
}

export interface MemoryTaskRow {
  id: string;
  title: string;
  summary: string | null;
  task_status: string;
  pinned: boolean;
  lifecycle: string;
  current_revision: number | null;
  created_at: number;
  updated_at: number;
  source_id: string | null;
  source_state: string;
}

export interface MemoryTaskPage {
  space: { id: string; kind: string; name: string };
  week: { week_start: number; week_end: number; timezone: string };
  items: MemoryTaskRow[];
  next: string | null;
}

export interface MemoryHealth {
  space: { id: string; kind: string };
  index: { heads: number; stale: number; last_indexed_at: number | null };
  events: {
    pending: number;
    rejected: number;
    oldest_pending_at: number | null;
  };
  jobs: {
    active: number;
    failed_24h: number;
    last_failure: {
      error_code: string | null;
      updated_at: number;
      kind: string;
    } | null;
  };
  spool: unknown;
  week: { week_start: number; week_end: number; timezone: string };
}

export interface MemoryCuratorStatus {
  revision: number;
  profile: unknown;
  credential: unknown;
  model_ready: boolean;
  mode: string;
  memory_enabled: boolean;
  extractor_version: string;
  policy_version: string;
}

export interface MemoryProposal {
  id: string;
  space_id: string;
  run_id: string;
  mode: string;
  operation: string;
  note_id: string | null;
  base_revision: number | null;
  kind: string | null;
  title: string | null;
  summary: string | null;
  rationale: string | null;
  claim_class: string | null;
  relation: string | null;
  target_note_id: string | null;
  risk: string | null;
  state: string;
  applied_revision: number | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export async function memoryGraph(
  spaceId: string,
  noteId: string,
  options: { depth?: number; maxNodes?: number; maxEdges?: number } = {},
): Promise<MemoryGraph> {
  const query = new URLSearchParams({ space_id: spaceId, note_id: noteId });
  if (options.depth !== undefined) query.set("depth", String(options.depth));
  if (options.maxNodes !== undefined)
    query.set("max_nodes", String(options.maxNodes));
  if (options.maxEdges !== undefined)
    query.set("max_edges", String(options.maxEdges));
  return api(`/api/memory/graph?${query.toString()}`);
}

export async function memoryRecall(input: {
  query: string;
  spaceId?: string;
  kinds?: string[];
  graphDepth?: number;
  limit?: number;
  cursor?: string;
  asOf?: string;
}): Promise<MemoryRecallPage> {
  const query = new URLSearchParams({ query: input.query });
  if (input.spaceId) query.set("space_id", input.spaceId);
  if (input.kinds?.length) query.set("kinds", input.kinds.join(","));
  if (input.graphDepth !== undefined)
    query.set("graph_depth", String(input.graphDepth));
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.asOf) query.set("as_of", input.asOf);
  return api(`/api/memory/recall?${query.toString()}`);
}

export async function memoryContext(input: {
  spaceId?: string;
  goal?: string;
  maxTokens?: number;
  known?: { note_id: string; revision: number }[];
  sessionKey?: string;
  generation?: number;
  branch?: string;
  worktree?: string;
}): Promise<MemoryContextPackage> {
  const query = new URLSearchParams();
  if (input.spaceId) query.set("space_id", input.spaceId);
  if (input.goal) query.set("goal", input.goal);
  if (input.maxTokens !== undefined)
    query.set("max_tokens", String(input.maxTokens));
  if (input.known?.length)
    query.set(
      "known",
      input.known
        .map((revision) => `${revision.note_id}:${revision.revision}`)
        .join(","),
    );
  if (input.sessionKey) query.set("session_key", input.sessionKey);
  if (input.generation !== undefined)
    query.set("generation", String(input.generation));
  if (input.branch) query.set("branch", input.branch);
  if (input.worktree) query.set("worktree", input.worktree);
  return api(`/api/memory/context?${query.toString()}`);
}

export async function memoryTasks(
  spaceId: string,
  options: {
    after?: string;
    limit?: number;
    statuses?: string[];
    weekOnly?: boolean;
  } = {},
): Promise<MemoryTaskPage> {
  const query = new URLSearchParams({ space_id: spaceId });
  if (options.after) query.set("after", options.after);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.statuses?.length)
    query.set("statuses", options.statuses.join(","));
  if (options.weekOnly) query.set("week_only", "1");
  return api(`/api/memory/tasks?${query.toString()}`);
}

export async function memoryHealth(spaceId: string): Promise<MemoryHealth> {
  const query = new URLSearchParams({ space_id: spaceId });
  return api(`/api/memory/health?${query.toString()}`);
}

export async function memoryCuratorStatus(): Promise<MemoryCuratorStatus> {
  return api("/api/memory/curator/status");
}

export async function memoryProposals(
  spaceId: string,
  options: { state?: string; after?: string; limit?: number } = {},
): Promise<{ items: MemoryProposal[]; next: string | null }> {
  const query = new URLSearchParams({ space_id: spaceId });
  if (options.state) query.set("state", options.state);
  if (options.after) query.set("after", options.after);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  return api(`/api/memory/curator/proposals?${query.toString()}`);
}

/**
 * The vault writer lock is short-lived but shared with the ingest worker: a
 * direct typed write can meet `memory_writer_busy`. Retry it a bounded number
 * of times so a transient lock never destroys the user's edit.
 */
async function withWriterRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const transient =
        errorCode(error) === "memory_writer_busy" ||
        (error instanceof ApiError && error.status >= 500);
      if (attempt >= 2 || !transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

export async function memoryUpdate(input: {
  spaceId: string;
  noteId: string;
  expectedRevision: number;
  patch: {
    kind?: string;
    title?: string;
    summary?: string;
    body?: string;
    lifecycle?: string;
    pinned?: boolean;
    task_status?: string;
    verification?: string;
    archive?: boolean;
    restore?: boolean;
    supersede_target?: string;
  };
}): Promise<{ status: string; note_id: string; revision: number }> {
  return withWriterRetry(() =>
    api("/api/memory/update", {
      method: "POST",
      body: JSON.stringify({
        space_id: input.spaceId,
        note_id: input.noteId,
        expected_revision: input.expectedRevision,
        event_key: `ui-update-${crypto.randomUUID()}`,
        ...input.patch,
      }),
    }),
  );
}

export async function memoryLink(input: {
  spaceId: string;
  noteId: string;
  relation: string;
  targetNoteId: string;
  remove?: boolean;
  expectedRevision: number;
}): Promise<{ status: string; note_id: string; revision: number }> {
  return withWriterRetry(() =>
    api("/api/memory/link", {
      method: "POST",
      body: JSON.stringify({
        space_id: input.spaceId,
        note_id: input.noteId,
        relation: input.relation,
        target_note_id: input.targetNoteId,
        ...(input.remove ? { remove: true } : {}),
        expected_revision: input.expectedRevision,
        event_key: `ui-link-${crypto.randomUUID()}`,
      }),
    }),
  );
}

export async function memoryCheckpoint(input: {
  spaceId: string;
  noteId?: string;
  expectedRevision?: number;
  goal: string;
  progress?: string;
  blocker?: string;
  nextStep?: string;
  status?: string;
}): Promise<{ status: string; note_id: string; revision: number }> {
  return withWriterRetry(() =>
    api("/api/memory/checkpoint", {
      method: "POST",
      body: JSON.stringify({
        space_id: input.spaceId,
        ...(input.noteId ? { note_id: input.noteId } : {}),
        ...(input.expectedRevision !== undefined
          ? { expected_revision: input.expectedRevision }
          : {}),
        goal: input.goal,
        ...(input.progress ? { progress: input.progress } : {}),
        ...(input.blocker ? { blocker: input.blocker } : {}),
        ...(input.nextStep ? { next_step: input.nextStep } : {}),
        ...(input.status ? { status: input.status } : {}),
        event_key: `ui-checkpoint-${crypto.randomUUID()}`,
      }),
    }),
  );
}

export const MEMORY_RELATIONS = [
  "SUPPORTS",
  "DERIVED_FROM",
  "PART_OF",
  "ABOUT",
  "PRECEDES",
  "SUPERSEDES",
  "CONTRADICTS",
  "DEPENDS_ON",
] as const;

export const MEMORY_KIND_OPTIONS = [
  "note",
  "decision",
  "fact",
  "procedure",
  "context",
  "research",
  "preference",
  "task",
  "session",
] as const;

export const TASK_STATUS_OPTIONS = [
  "planned",
  "doing",
  "blocked",
  "done",
  "cancelled",
] as const;
