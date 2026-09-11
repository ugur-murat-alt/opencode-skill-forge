import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Issue #34 (M01): the Markdown memory format v1 contract. This module is a
 * pure codec and vocabulary: no database, IO, application or transport
 * imports. It owns the portable note format (frontmatter + body), canonical
 * serialization/hash, supersession cycle detection, wikilink resolution and
 * the typed space scope. The operational DB stores identity/ACL and accepted
 * revision manifests; derived views are rebuilt from the Markdown contract,
 * never from this module directly.
 */

export const MEMORY_FORMAT_VERSION = 1 as const;

/** AGZ-compatible note kinds plus the small additions "note" and "session". */
export const MEMORY_KINDS = [
  "decision",
  "fact",
  "procedure",
  "context",
  "research",
  "preference",
  "task",
  "note",
  "session",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * AGZ-compatible relations. CONTRADICTS/DEPENDS_ON are explicit additions
 * with their own semantics; an automatic contradiction never deletes the
 * current record.
 */
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
export type MemoryRelation = (typeof MEMORY_RELATIONS)[number];

/** Note lifecycle. Task status is a separate axis (see below). */
export const MEMORY_LIFECYCLES = ["active", "superseded", "archived"] as const;
export type MemoryLifecycle = (typeof MEMORY_LIFECYCLES)[number];

/** Task progress, tracked independently from the note lifecycle. */
export const TASK_STATUSES = [
  "planned",
  "doing",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * User declaration, externally verified fact and model proposal are three
 * distinct states and must never collapse into each other.
 */
export const MEMORY_VERIFICATIONS = [
  "declared",
  "verified",
  "proposed",
] as const;
export type MemoryVerification = (typeof MEMORY_VERIFICATIONS)[number];

export const MEMORY_SPACE_KINDS = [
  "personal",
  "project",
  "organization",
] as const;
export type MemorySpaceKind = (typeof MEMORY_SPACE_KINDS)[number];

/**
 * A space scope is explicit and typed. A project space always names a real
 * project; personal/organization spaces never fabricate a project id. A
 * same-named project or folder is not the same identity.
 */
export type MemorySpaceScope =
  | { readonly type: "personal" }
  | { readonly type: "project"; readonly projectId: string }
  | { readonly type: "organization" };

export function memoryScopeKind(scope: MemorySpaceScope): MemorySpaceKind {
  return scope.type;
}

/** Stable scope key used by idempotency/ACL bookkeeping (not a project id). */
export function memoryScopeKey(
  scope: MemorySpaceScope,
  identity: { userId: string },
): string {
  if (scope.type === "project") return scope.projectId;
  if (scope.type === "personal") return identity.userId;
  return "organization";
}

export const memorySourceSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.string().min(1).max(40).optional(),
    revision: z.string().min(1).max(200).optional(),
    hash: z.string().min(1).max(200).optional(),
    url: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryEdgeSchema = z
  .object({
    relation: z.enum(MEMORY_RELATIONS),
    target: z.string().min(1).max(200),
  })
  .strict();
export type MemoryEdge = z.infer<typeof memoryEdgeSchema>;

const memoryFrontmatterSchema = z.object({
  format_version: z.number().int().min(1).max(1000),
  note_id: z.string().min(1).max(200),
  memory_space_id: z.string().min(1).max(200),
  kind: z.enum(MEMORY_KINDS),
  title: z.string().min(1).max(500),
  summary: z.string().max(8000).optional(),
  lifecycle: z.enum(MEMORY_LIFECYCLES).optional(),
  pinned: z.boolean().optional(),
  task_status: z.enum(TASK_STATUSES).optional(),
  verification: z.enum(MEMORY_VERIFICATIONS).optional(),
  stale: z.boolean().optional(),
  sources: z.array(memorySourceSchema).max(100).optional(),
  edges: z.array(memoryEdgeSchema).max(200).optional(),
  created_at: z.number().int().min(0).optional(),
  observed_at: z.number().int().min(0).optional(),
  valid_from: z.number().int().min(0).optional(),
  valid_until: z.number().int().min(0).optional(),
  base_revision: z.number().int().min(0).optional(),
  revision: z.number().int().min(0).optional(),
});

export interface MemoryRecord {
  readonly formatVersion: number;
  readonly noteId: string;
  readonly spaceId: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly summary: string | null;
  readonly lifecycle: MemoryLifecycle;
  readonly pinned: boolean;
  readonly taskStatus: TaskStatus | null;
  readonly verification: MemoryVerification;
  readonly stale: boolean | null;
  readonly sources: readonly MemorySource[];
  readonly edges: readonly MemoryEdge[];
  readonly createdAt: number | null;
  readonly observedAt: number | null;
  readonly validFrom: number | null;
  readonly validUntil: number | null;
  readonly baseRevision: number | null;
  readonly revision: number | null;
  /** Unknown user frontmatter, preserved on rewrite and inert for authority. */
  readonly unknown: Readonly<Record<string, unknown>>;
  /** Body text exactly as parsed (raw line endings included). */
  readonly body: string;
}

export type MemoryParseResult =
  | { readonly status: "ok"; readonly record: MemoryRecord }
  | { readonly status: "unsupported_format"; readonly formatVersion: number }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

const KNOWN_FRONTMATTER_KEYS = new Set([
  "format_version",
  "note_id",
  "memory_space_id",
  "kind",
  "title",
  "summary",
  "lifecycle",
  "pinned",
  "task_status",
  "verification",
  "stale",
  "sources",
  "edges",
  "created_at",
  "observed_at",
  "valid_from",
  "valid_until",
  "base_revision",
  "revision",
]);

function splitFrontmatter(
  source: string,
): { raw: string; body: string } | { error: "missing_frontmatter" } {
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) return { error: "missing_frontmatter" };
  const rest = source.slice(open[0].length);
  const close = /(?:^|\n)---[ \t]*(?=\r?\n|$)/.exec(rest);
  if (!close) return { error: "missing_frontmatter" };
  const delimiterStart = close.index + (close[0].startsWith("\n") ? 1 : 0);
  const delimiterEnd = close.index + close[0].length;
  const after = rest.slice(delimiterEnd);
  const lineEnd = /^\r?\n/.exec(after);
  return {
    raw: rest.slice(0, delimiterStart),
    body: lineEnd ? after.slice(lineEnd[0].length) : after,
  };
}

/** Tolerant scalar reader for hand-edited frontmatter: JSON or plain text. */
function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (value.startsWith("[") || value.startsWith("{") || value.startsWith('"')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Fall through to the plain-text interpretation.
    }
  }
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  )
    return value.slice(1, -1);
  return value;
}

function parseFrontmatterLines(raw: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    const text = trimmed.trimStart();
    if (!text || text.startsWith("#")) continue;
    const colon = text.indexOf(":");
    if (colon <= 0) continue;
    const key = text.slice(0, colon).trim();
    if (!key) continue;
    values[key] = parseScalar(text.slice(colon + 1));
  }
  return values;
}

export function parseMemoryDocument(source: string): MemoryParseResult {
  const split = splitFrontmatter(source);
  if ("error" in split) return { status: "invalid", issues: [split.error] };
  const values = parseFrontmatterLines(split.raw);
  const rawVersion = values.format_version;
  if (
    typeof rawVersion === "number" &&
    Number.isInteger(rawVersion) &&
    rawVersion > MEMORY_FORMAT_VERSION
  )
    return { status: "unsupported_format", formatVersion: rawVersion };
  const parsed = memoryFrontmatterSchema.safeParse(values);
  if (!parsed.success)
    return {
      status: "invalid",
      issues: parsed.error.issues.map(
        (issue) =>
          `${issue.path.length ? issue.path.join(".") : "frontmatter"}: ${issue.message}`,
      ),
    };
  const fm = parsed.data;
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values))
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) unknown[key] = value;
  return {
    status: "ok",
    record: {
      formatVersion: fm.format_version,
      noteId: fm.note_id,
      spaceId: fm.memory_space_id,
      kind: fm.kind,
      title: fm.title,
      summary: fm.summary ?? null,
      lifecycle: fm.lifecycle ?? "active",
      pinned: fm.pinned ?? false,
      taskStatus: fm.task_status ?? null,
      verification: fm.verification ?? "declared",
      stale: fm.stale ?? null,
      sources: fm.sources ?? [],
      edges: fm.edges ?? [],
      createdAt: fm.created_at ?? null,
      observedAt: fm.observed_at ?? null,
      validFrom: fm.valid_from ?? null,
      validUntil: fm.valid_until ?? null,
      baseRevision: fm.base_revision ?? null,
      revision: fm.revision ?? null,
      unknown,
      body: split.body,
    },
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          stableValue((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null || value === undefined) return "null";
  return JSON.stringify(stableValue(value));
}

export interface SerializeMemoryOptions {
  /** Canonical hashing omits the mutable revision field. */
  readonly includeRevision?: boolean;
}

/**
 * Canonical serialization: LF line endings, fixed known-field order, unknown
 * fields sorted and preserved. The body is emitted verbatim except that CRLF
 * is canonicalized to LF; no Unicode normalization is applied, so user
 * meaning is never silently rewritten.
 */
export function serializeMemoryDocument(
  record: MemoryRecord,
  options: SerializeMemoryOptions = {},
): string {
  const lines: string[] = [];
  const push = (key: string, value: unknown) =>
    lines.push(`${key}: ${formatScalar(value)}`);
  push("format_version", record.formatVersion);
  push("note_id", record.noteId);
  push("memory_space_id", record.spaceId);
  push("kind", record.kind);
  push("title", record.title);
  if (record.summary !== null) push("summary", record.summary);
  push("lifecycle", record.lifecycle);
  push("pinned", record.pinned);
  if (record.taskStatus !== null) push("task_status", record.taskStatus);
  push("verification", record.verification);
  if (record.stale !== null) push("stale", record.stale);
  push("sources", record.sources);
  push("edges", record.edges);
  if (record.createdAt !== null) push("created_at", record.createdAt);
  if (record.observedAt !== null) push("observed_at", record.observedAt);
  if (record.validFrom !== null) push("valid_from", record.validFrom);
  if (record.validUntil !== null) push("valid_until", record.validUntil);
  if (record.baseRevision !== null) push("base_revision", record.baseRevision);
  if (options.includeRevision !== false && record.revision !== null)
    push("revision", record.revision);
  for (const key of Object.keys(record.unknown).sort()) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    push(key, record.unknown[key]);
  }
  const body = record.body.replace(/\r\n?/g, "\n");
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** Canonical text hashed for change detection; excludes `revision`. */
export function canonicalMemoryText(record: MemoryRecord): string {
  return serializeMemoryDocument(record, { includeRevision: false });
}

/** SHA-256 of the canonical record; the hash never covers itself. */
export function memoryRecordHash(record: MemoryRecord): string {
  return createHash("sha256").update(canonicalMemoryText(record)).digest("hex");
}

/** Note identity used by wikilinks: note_id is immutable, title is not. */
export interface MemoryNoteRef {
  readonly noteId: string;
  readonly title: string;
}

export type WikilinkResolution =
  | { readonly status: "resolved"; readonly noteId: string }
  | { readonly status: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly status: "missing"; readonly title: string };

export function extractWikilinks(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\[\[([^[\]]+)\]\]/g)) {
    const target = match[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Resolve a wikilink target by exact title. Multiple notes sharing a title
 * are never resolved at random: the caller receives the candidate list.
 */
export function resolveWikilink(
  target: string,
  notes: readonly MemoryNoteRef[],
): WikilinkResolution {
  const wanted = target.trim();
  const candidates = [
    ...new Set(
      notes
        .filter((note) => note.title.trim() === wanted)
        .map((note) => note.noteId),
    ),
  ];
  if (candidates.length === 1)
    return { status: "resolved", noteId: candidates[0]! };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "missing", title: wanted };
}

export interface SupersessionNode {
  readonly noteId: string;
  readonly supersedes: readonly string[];
}

/**
 * Detect a cycle in the SUPERSEDES graph. Returns the first cycle as a closed
 * path (first element repeated at the end) or null when the chain is legal.
 */
export function detectSupersessionCycle(
  nodes: readonly SupersessionNode[],
): string[] | null {
  const graph = new Map(nodes.map((node) => [node.noteId, node.supersedes]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    const current = state.get(node) ?? 0;
    if (current === 2) return null;
    if (current === 1) {
      const start = stack.indexOf(node);
      return [...stack.slice(start === -1 ? 0 : start), node];
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node.noteId);
    if (cycle) return cycle;
  }
  return null;
}

export function supersedesTargets(record: MemoryRecord): string[] {
  return record.edges
    .filter((edge) => edge.relation === "SUPERSEDES")
    .map((edge) => edge.target);
}
