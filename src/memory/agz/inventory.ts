/**
 * AGZ-Memory salt-okunur envanter ve dry-run raporu.
 *
 * Bu modül kaynak AGZ veritabanını yalnız `readonly` açar; hiçbir yazma
 * yolu, migration, repair veya WAL mutasyonu üretmez. Desteklenmeyen şema
 * sürümü ve tanınmayan v11 parmak izi mutasyonsuz reddedilir
 * (`unsupported_source_schema`). Çıktı, hedefe neyin eşleneceğini ve hangi
 * kayıtların çatışma/karantina gerektirdiğini gösterir; gerçek değişiklik
 * yapmaz.
 *
 * Hedef hafıza modülü henüz yoktur; bu dosya ona import etmez. Yalnız AGZ
 * kaynağına, yerel SQLite sürücüsüne ve `node:crypto`'ya bağlıdır.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { AgzSourceError } from "./errors.js";
import { hashTuple, noteContentHash, type HashTupleValue } from "./hash.js";
import {
  AGZ_APPLICATION_ID,
  AGZ_EXPECTED_SCHEMA_V11_FINGERPRINT,
  AGZ_HASH_POLICY,
  AGZ_PRODUCT_ID,
  AGZ_SUPPORTED_SCHEMA_VERSION,
  computeSchemaFingerprint,
} from "./schema-v11.js";
import {
  openReadOnlySqlite,
  type SqliteConnection,
  type SqlValue,
} from "./sqlite-driver.js";

export const AGZ_INVENTORY_REPORT_VERSION = 1 as const;
export const AGZ_INVENTORY_DEFAULT_BATCH_SIZE = 200;
export const AGZ_INVENTORY_MAX_BATCH_SIZE = 1000;
const MAX_REPORT_ISSUES = 5_000;

export type AgzKind =
  | "decision"
  | "fact"
  | "procedure"
  | "context"
  | "research"
  | "preference"
  | "task";

export type AgzPredicate =
  "SUPPORTS" | "DERIVED_FROM" | "PART_OF" | "ABOUT" | "PRECEDES" | "SUPERSEDES";

export type AgzNoteStatus = "active" | "superseded" | "archived";

export type AgzScanEntity =
  "projects" | "notes" | "revisions" | "edges" | "provenance";

export interface AgzPageRequest {
  cursor?: string | null;
  limit?: number;
}

export interface AgzScanPage<Item> {
  items: Item[];
  nextCursor: string | null;
}

export interface AgzSourceFileState {
  path: string;
  sha256: string;
  sizeBytes: number;
  walPresent: boolean;
  shmPresent: boolean;
}

export interface AgzSourceIdentity {
  productId: string;
  databaseId: string;
  schemaVersion: number;
  hashPolicy: string;
  schemaFingerprint: string;
  applicationId: number;
  journalMode: string;
  integrityCheck: string;
  foreignKeyViolationCount: number;
  file: AgzSourceFileState;
}

export interface AgzProjectRecord {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgzNoteRecord {
  id: string;
  projectId: string;
  kind: AgzKind;
  title: string;
  summary: string;
  content: string;
  sizeClass: string;
  pinned: boolean;
  status: AgzNoteStatus;
  supersedesId: string | null;
  currentRevision: number;
  subjectKey: string | null;
  contentHash: string;
  recomputedContentHash: string;
  contentHashMatches: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgzRevisionRecord {
  projectId: string;
  noteId: string;
  revision: number;
  kind: AgzKind;
  title: string;
  summary: string;
  content: string;
  sizeClass: string;
  pinned: boolean;
  status: AgzNoteStatus;
  supersedesId: string | null;
  subjectKey: string | null;
  contentHash: string;
  recomputedContentHash: string;
  contentHashMatches: boolean;
  provenanceId: string;
  createdAt: number;
}

export interface AgzEdgeRecord {
  id: string;
  projectId: string;
  sourceId: string;
  targetId: string;
  predicate: AgzPredicate;
  createdAt: number;
}

export interface AgzProvenanceRecord {
  id: string;
  projectId: string;
  noteId: string;
  sourceType: string;
  captureEventId: string | null;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  sourceOrdinal: number | null;
  sourceToolCallId: string | null;
  redactionVersion: string | null;
  extractorVersion: string | null;
  confidence: number | null;
  createdAt: number;
}

export interface AgzInventoryCounts {
  schemaVersion: number;
  projects: number;
  notes: number;
  notesActive: number;
  notesSuperseded: number;
  notesArchived: number;
  notesPinned: number;
  revisions: number;
  provenance: number;
  edges: number;
  edgesByPredicate: Record<AgzPredicate, number>;
  captureEvents: number;
  captureEventStates: Record<string, number>;
  captureCheckpoints: number;
  projectBindings: number;
  outbox: number;
  outboxStates: Record<string, number>;
}

export type AgzIssueSeverity = "blocking" | "warning";

export interface AgzReportIssue {
  code: string;
  severity: AgzIssueSeverity;
  entity: "project" | "note" | "revision" | "edge" | "provenance" | "source";
  detail: string;
  projectId?: string;
  noteId?: string;
  edgeId?: string;
  provenanceId?: string;
  revision?: number;
}

export interface AgzExclusion {
  table: string;
  count: number;
  reason: string;
}

export interface AgzProjectPlan {
  sourceProjectId: string;
  sourceName: string;
  normalizedName: string;
  noteCount: number;
  activeCount: number;
  supersededCount: number;
  archivedCount: number;
  pinnedCount: number;
  revisionCount: number;
  provenanceCount: number;
  edgeCount: number;
}

export interface AgzPlanTotals {
  projects: number;
  notes: number;
  active: number;
  superseded: number;
  archived: number;
  pinned: number;
  revisions: number;
  provenance: number;
  edges: number;
}

export interface AgzDryRunReport {
  kind: "agz-memory-dry-run";
  reportVersion: typeof AGZ_INVENTORY_REPORT_VERSION;
  generatedAt: number;
  dryRun: true;
  source: AgzSourceIdentity;
  counts: AgzInventoryCounts;
  plan: { totals: AgzPlanTotals; projects: AgzProjectPlan[] };
  digest: string;
  issues: AgzReportIssue[];
  issuesTruncated: boolean;
  exclusions: AgzExclusion[];
  decision: {
    status: "ready" | "blocked";
    blockingIssues: number;
    warningIssues: number;
  };
}

export interface OpenAgzSourceOptions {
  batchSize?: number;
  verifyIntegrity?: boolean;
  now?: () => number;
}

export interface AgzSource {
  readonly identity: AgzSourceIdentity;
  counts(): AgzInventoryCounts;
  scanProjects(page?: AgzPageRequest): AgzScanPage<AgzProjectRecord>;
  scanNotes(page?: AgzPageRequest): AgzScanPage<AgzNoteRecord>;
  scanRevisions(page?: AgzPageRequest): AgzScanPage<AgzRevisionRecord>;
  scanEdges(page?: AgzPageRequest): AgzScanPage<AgzEdgeRecord>;
  scanProvenance(page?: AgzPageRequest): AgzScanPage<AgzProvenanceRecord>;
  buildDryRunReport(): AgzDryRunReport;
  verifyUnchanged(): Promise<void>;
  close(): Promise<void>;
}

interface FileFingerprint {
  sha256: string;
  sizeBytes: number;
}

interface CapturedFiles {
  database: FileFingerprint;
  wal: FileFingerprint | null;
  shm: FileFingerprint | null;
}

const ENTITY_KEY_COUNTS: Record<AgzScanEntity, number> = {
  projects: 1,
  notes: 2,
  revisions: 3,
  edges: 2,
  provenance: 2,
};

const CAPTURE_EVENT_STATES = [
  "pending",
  "shadowed",
  "review",
  "materialized",
  "duplicate",
  "ignored",
  "rejected",
  "quarantined",
  "failed",
  "dead",
] as const;

const OUTBOX_STATES = ["pending", "leased", "succeeded", "dead"] as const;

const PREDICATES: readonly AgzPredicate[] = [
  "SUPPORTS",
  "DERIVED_FROM",
  "PART_OF",
  "ABOUT",
  "PRECEDES",
  "SUPERSEDES",
];

export async function openAgzSource(
  path: string,
  options: OpenAgzSourceOptions = {},
): Promise<AgzSource> {
  const batchSize = resolveBatchSize(options.batchSize);
  const now = options.now ?? Date.now;
  const verifyIntegrity = options.verifyIntegrity ?? true;

  await assertSourceFile(path);
  await assertFrozenSnapshot(path);
  const captured = await captureFiles(path);
  let db: SqliteConnection;
  try {
    db = await openReadOnlySqlite(path);
  } catch (error) {
    throw wrapProbeFailure(error);
  }
  let opened = false;
  try {
    const identity = readIdentity(db, path, captured, verifyIntegrity);
    opened = true;
    return createSource({ db, identity, batchSize, now, captured });
  } catch (error) {
    if (error instanceof AgzSourceError) throw error;
    throw wrapProbeFailure(error);
  } finally {
    if (!opened) db.close();
  }
}

interface SourceContext {
  db: SqliteConnection;
  identity: AgzSourceIdentity;
  batchSize: number;
  now: () => number;
  captured: CapturedFiles;
}

function createSource(context: SourceContext): AgzSource {
  const { db, batchSize, captured } = context;
  let closed = false;
  const verifyUnchanged = async (): Promise<void> => {
    const current = await captureFiles(context.identity.file.path);
    if (!sameFile(captured.database, current.database)) {
      throw new AgzSourceError(
        "source_changed_during_scan",
        "kaynak veritabanı dosyası tarama sırasında değişti",
        { path: context.identity.file.path },
      );
    }
    if (!sameFile(captured.wal, current.wal)) {
      throw new AgzSourceError(
        "source_changed_during_scan",
        "kaynak WAL yan dosyası tarama sırasında değişti",
        { sidecar: `${context.identity.file.path}-wal` },
      );
    }
    if (!sameFile(captured.shm, current.shm)) {
      throw new AgzSourceError(
        "source_changed_during_scan",
        "kaynak SHM yan dosyası tarama sırasında değişti",
        { sidecar: `${context.identity.file.path}-shm` },
      );
    }
  };
  return {
    identity: context.identity,
    counts: () => readCounts(db, context.identity),
    scanProjects: (page) =>
      scanKeyset<ProjectRow, AgzProjectRecord>(
        db,
        "projects",
        page,
        batchSize,
        {
          select:
            "SELECT id, name, normalized_name, created_at, updated_at FROM projects",
          where: "1 = 1",
          orderBy: "id",
          keyColumns: "(id)",
          keyOf: (row) => [row.id],
          map: mapProject,
        },
      ),
    scanNotes: (page) =>
      scanKeyset<NoteRow, AgzNoteRecord>(db, "notes", page, batchSize, {
        select: `SELECT id, project_id, kind, title, summary, content, size_class,
                        pinned, status, supersedes_id, current_revision, subject_key,
                        content_hash, created_at, updated_at
                   FROM notes`,
        where: "1 = 1",
        orderBy: "project_id, id",
        keyColumns: "(project_id, id)",
        keyOf: (row) => [row.project_id, row.id],
        map: mapNote,
      }),
    scanRevisions: (page) =>
      scanKeyset<RevisionRow, AgzRevisionRecord>(
        db,
        "revisions",
        page,
        batchSize,
        {
          select: `SELECT project_id, note_id, revision, kind, title, summary, content,
                          size_class, pinned, status, supersedes_id, subject_key,
                          content_hash, provenance_id, created_at
                     FROM note_revisions`,
          where: "1 = 1",
          orderBy: "project_id, note_id, revision",
          keyColumns: "(project_id, note_id, revision)",
          keyOf: (row) => [row.project_id, row.note_id, row.revision],
          map: mapRevision,
        },
      ),
    scanEdges: (page) =>
      scanKeyset<EdgeRow, AgzEdgeRecord>(db, "edges", page, batchSize, {
        select: `SELECT id, project_id, source_id, target_id, predicate, created_at
                   FROM note_edges`,
        where: "1 = 1",
        orderBy: "project_id, id",
        keyColumns: "(project_id, id)",
        keyOf: (row) => [row.project_id, row.id],
        map: (row) => ({
          id: row.id,
          projectId: row.project_id,
          sourceId: row.source_id,
          targetId: row.target_id,
          predicate: row.predicate as AgzPredicate,
          createdAt: row.created_at,
        }),
      }),
    scanProvenance: (page) =>
      scanKeyset<ProvenanceRow, AgzProvenanceRecord>(
        db,
        "provenance",
        page,
        batchSize,
        {
          select: `SELECT id, project_id, note_id, source_type, capture_event_id,
                          source_session_id, source_message_id, source_ordinal,
                          source_tool_call_id, redaction_version, extractor_version,
                          confidence, created_at
                     FROM note_provenance`,
          where: "1 = 1",
          orderBy: "project_id, id",
          keyColumns: "(project_id, id)",
          keyOf: (row) => [row.project_id, row.id],
          map: (row) => ({
            id: row.id,
            projectId: row.project_id,
            noteId: row.note_id,
            sourceType: row.source_type,
            captureEventId: row.capture_event_id,
            sourceSessionId: row.source_session_id,
            sourceMessageId: row.source_message_id,
            sourceOrdinal: row.source_ordinal,
            sourceToolCallId: row.source_tool_call_id,
            redactionVersion: row.redaction_version,
            extractorVersion: row.extractor_version,
            confidence: row.confidence,
            createdAt: row.created_at,
          }),
        },
      ),
    buildDryRunReport: () => buildReport(context),
    verifyUnchanged,
    close: async () => {
      if (closed) return;
      try {
        await verifyUnchanged();
      } finally {
        closed = true;
        db.close();
      }
    },
  };
}

async function assertSourceFile(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new AgzSourceError(
        "source_not_found",
        `kaynak veritabanı bulunamadı: ${path}`,
        { path },
      );
    }
    throw error;
  });
  if (info.isSymbolicLink()) {
    throw new AgzSourceError(
      "source_path_unsafe",
      `kaynak veritabanı sembolik bağlantı olamaz: ${path}`,
      { path },
    );
  }
  if (!info.isFile()) {
    throw new AgzSourceError(
      "source_not_found",
      `kaynak veritabanı düzenli dosya değil: ${path}`,
      { path },
    );
  }
}

const SQLITE_MAGIC = "SQLite format 3\u0000";

async function assertFrozenSnapshot(path: string): Promise<void> {
  const walPath = `${path}-wal`;
  const shmPath = `${path}-shm`;
  const walPresent = existsSync(walPath);
  const shmPresent = existsSync(shmPath);
  if (walPresent || shmPresent) {
    throw new AgzSourceError(
      "source_snapshot_not_frozen",
      "kaynakta WAL/SHM yan dosyası var; canlı dosya yerine dondurulmuş anlık görüntü gerekir",
      { reason: "sidecar_present", walPresent, shmPresent },
    );
  }
  const header = await readHeader(path);
  if (
    header.length < 100 ||
    header.toString("latin1", 0, 16) !== SQLITE_MAGIC
  ) {
    throw new AgzSourceError(
      "unsupported_source_schema",
      "dosya geçerli bir SQLite veritabanı başlığı taşımıyor",
      { reason: "not_a_sqlite_database" },
    );
  }
  const writeVersion = header[18] ?? -1;
  const readVersion = header[19] ?? -1;
  if (writeVersion !== 1 || readVersion !== 1) {
    throw new AgzSourceError(
      "source_snapshot_not_frozen",
      "kaynak WAL günlük modunda; önce dondurulmuş kopya (VACUUM INTO veya journal_mode=DELETE) alınmalı",
      { reason: "wal_mode_source", writeVersion, readVersion },
    );
  }
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(100);
    const { bytesRead } = await handle.read(buffer, 0, 100, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function captureFiles(path: string): Promise<CapturedFiles> {
  const walPath = `${path}-wal`;
  const shmPath = `${path}-shm`;
  return {
    database: await hashFile(path),
    wal: existsSync(walPath) ? await hashFile(walPath) : null,
    shm: existsSync(shmPath) ? await hashFile(shmPath) : null,
  };
}

async function hashFile(path: string): Promise<FileFingerprint> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

function sameFile(
  before: FileFingerprint | null,
  after: FileFingerprint | null,
): boolean {
  if (before === null || after === null) return before === after;
  return before.sha256 === after.sha256 && before.sizeBytes === after.sizeBytes;
}

function wrapProbeFailure(error: unknown): AgzSourceError {
  if (error instanceof AgzSourceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AgzSourceError(
    "unsupported_source_schema",
    `kaynak şema bilgisi okunamadı: ${message}`,
    { reason: "schema_probe_failed" },
  );
}

function readIdentity(
  db: SqliteConnection,
  path: string,
  captured: CapturedFiles,
  verifyIntegrity: boolean,
): AgzSourceIdentity {
  const states = db.all<{ version: unknown }>(
    "SELECT version FROM schema_state",
  );
  const version = states.length === 1 ? states[0]?.version : undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new AgzSourceError(
      "unsupported_source_schema",
      "schema_state tek ve geçerli bir sürüm içermiyor",
      { reason: "schema_state_invalid" },
    );
  }
  if (version > AGZ_SUPPORTED_SCHEMA_VERSION) {
    throw new AgzSourceError(
      "unsupported_source_schema",
      `kaynak şema v${version} desteklenen v${AGZ_SUPPORTED_SCHEMA_VERSION} sürümünden yeni`,
      {
        reason: "future_schema",
        foundSchemaVersion: version,
        supportedSchemaVersion: AGZ_SUPPORTED_SCHEMA_VERSION,
      },
    );
  }
  if (version < AGZ_SUPPORTED_SCHEMA_VERSION) {
    throw new AgzSourceError(
      "unsupported_source_schema",
      `kaynak şema v${version}; önce AGZ tarafında v${AGZ_SUPPORTED_SCHEMA_VERSION} sürümüne yükseltilmiş doğrulanmış yedek gerekir`,
      {
        reason: "older_schema",
        foundSchemaVersion: version,
        supportedSchemaVersion: AGZ_SUPPORTED_SCHEMA_VERSION,
      },
    );
  }

  const metas = db.all<MetaRow>(
    `SELECT id, database_id, product_id, schema_version, schema_fingerprint,
            hash_policy, created_at
       FROM agz_meta`,
  );
  if (metas.length !== 1) {
    throw new AgzSourceError(
      "source_identity_mismatch",
      "agz_meta tek satır içermeli",
      { metaRows: metas.length },
    );
  }
  const meta = metas[0]!;
  if (
    meta.id !== 1 ||
    meta.product_id !== AGZ_PRODUCT_ID ||
    meta.schema_version !== AGZ_SUPPORTED_SCHEMA_VERSION ||
    meta.hash_policy !== AGZ_HASH_POLICY
  ) {
    throw new AgzSourceError(
      "source_identity_mismatch",
      "agz_meta kimlik alanları AGZ v11 ile uyuşmuyor",
      {
        productId: meta.product_id,
        schemaVersion: meta.schema_version,
        hashPolicy: meta.hash_policy,
      },
    );
  }
  const applicationId =
    db.get<{ application_id: number }>("PRAGMA application_id")
      ?.application_id ?? -1;
  if (applicationId !== AGZ_APPLICATION_ID) {
    throw new AgzSourceError(
      "source_identity_mismatch",
      "application_id AGZ v11 ile uyuşmuyor",
      { applicationId, expectedApplicationId: AGZ_APPLICATION_ID },
    );
  }
  const computedFingerprint = computeSchemaFingerprint(db);
  if (computedFingerprint !== meta.schema_fingerprint) {
    throw new AgzSourceError(
      "source_identity_mismatch",
      "kayıtlı ve hesaplanan şema parmak izi uyuşmuyor",
      {
        recorded: meta.schema_fingerprint,
        computed: computedFingerprint,
      },
    );
  }
  if (computedFingerprint !== AGZ_EXPECTED_SCHEMA_V11_FINGERPRINT) {
    throw new AgzSourceError(
      "unsupported_source_schema",
      "şema v11 ancak parmak izi bilinen AGZ 0.5.2 v11 ile eşleşmiyor",
      {
        reason: "unknown_schema_v11_variant",
        computedFingerprint,
        expectedFingerprint: AGZ_EXPECTED_SCHEMA_V11_FINGERPRINT,
      },
    );
  }

  let integrityCheck = "skipped";
  let foreignKeyViolationCount = 0;
  if (verifyIntegrity) {
    integrityCheck =
      db.get<{ integrity_check: string }>("PRAGMA integrity_check")
        ?.integrity_check ?? "unknown";
    if (integrityCheck !== "ok") {
      throw new AgzSourceError(
        "source_integrity_failed",
        `kaynak integrity_check başarısız: ${integrityCheck}`,
        { integrityCheck },
      );
    }
    foreignKeyViolationCount = db.all("PRAGMA foreign_key_check").length;
  }

  const journalMode =
    db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode ??
    "unknown";

  return {
    productId: meta.product_id,
    databaseId: meta.database_id,
    schemaVersion: AGZ_SUPPORTED_SCHEMA_VERSION,
    hashPolicy: meta.hash_policy,
    schemaFingerprint: computedFingerprint,
    applicationId,
    journalMode,
    integrityCheck,
    foreignKeyViolationCount,
    file: {
      path,
      sha256: captured.database.sha256,
      sizeBytes: captured.database.sizeBytes,
      walPresent: captured.wal !== null,
      shmPresent: captured.shm !== null,
    },
  };
}

interface MetaRow {
  id: number;
  database_id: string;
  product_id: string;
  schema_version: number;
  schema_fingerprint: string;
  hash_policy: string;
  created_at: number;
}

interface ProjectRow {
  id: string;
  name: string;
  normalized_name: string;
  created_at: number;
  updated_at: number;
}

interface NoteRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  size_class: string;
  pinned: number;
  status: string;
  supersedes_id: string | null;
  current_revision: number;
  subject_key: string | null;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

interface RevisionRow {
  project_id: string;
  note_id: string;
  revision: number;
  kind: string;
  title: string;
  summary: string;
  content: string;
  size_class: string;
  pinned: number;
  status: string;
  supersedes_id: string | null;
  subject_key: string | null;
  content_hash: string;
  provenance_id: string;
  created_at: number;
}

interface EdgeRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  predicate: string;
  created_at: number;
}

interface ProvenanceRow {
  id: string;
  project_id: string;
  note_id: string;
  source_type: string;
  capture_event_id: string | null;
  source_session_id: string | null;
  source_message_id: string | null;
  source_ordinal: number | null;
  source_tool_call_id: string | null;
  redaction_version: string | null;
  extractor_version: string | null;
  confidence: number | null;
  created_at: number;
}

function mapProject(row: ProjectRow): AgzProjectRecord {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNote(row: NoteRow): AgzNoteRecord {
  const recomputed = noteContentHash(
    row.kind,
    row.title,
    row.summary,
    row.content,
  );
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as AgzKind,
    title: row.title,
    summary: row.summary,
    content: row.content,
    sizeClass: row.size_class,
    pinned: row.pinned === 1,
    status: row.status as AgzNoteStatus,
    supersedesId: row.supersedes_id,
    currentRevision: row.current_revision,
    subjectKey: row.subject_key,
    contentHash: row.content_hash,
    recomputedContentHash: recomputed,
    contentHashMatches: row.content_hash === recomputed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRevision(row: RevisionRow): AgzRevisionRecord {
  const recomputed = noteContentHash(
    row.kind,
    row.title,
    row.summary,
    row.content,
  );
  return {
    projectId: row.project_id,
    noteId: row.note_id,
    revision: row.revision,
    kind: row.kind as AgzKind,
    title: row.title,
    summary: row.summary,
    content: row.content,
    sizeClass: row.size_class,
    pinned: row.pinned === 1,
    status: row.status as AgzNoteStatus,
    supersedesId: row.supersedes_id,
    subjectKey: row.subject_key,
    contentHash: row.content_hash,
    recomputedContentHash: recomputed,
    contentHashMatches: row.content_hash === recomputed,
    provenanceId: row.provenance_id,
    createdAt: row.created_at,
  };
}

interface KeysetScan<Row, Item> {
  select: string;
  where: string;
  orderBy: string;
  keyColumns: string;
  keyOf: (row: Row) => SqlValue[];
  map: (row: Row) => Item;
}

function scanKeyset<Row, Item>(
  db: SqliteConnection,
  entity: AgzScanEntity,
  page: AgzPageRequest | undefined,
  defaultLimit: number,
  query: KeysetScan<Row, Item>,
): AgzScanPage<Item> {
  const limit = resolveLimit(page?.limit, defaultLimit);
  const cursorKeys = page?.cursor ? decodeCursor(entity, page.cursor) : null;
  const condition = cursorKeys
    ? `AND ${query.keyColumns} > (${cursorKeys.map(() => "?").join(", ")})`
    : "";
  const params: SqlValue[] = [...(cursorKeys ?? []), limit];
  const rows = db.all<Row>(
    `${query.select} WHERE ${query.where} ${condition} ORDER BY ${query.orderBy} LIMIT ?`,
    params,
  );
  const items = rows.map(query.map);
  const last = rows.at(-1);
  return {
    items,
    nextCursor:
      rows.length === limit && last
        ? encodeCursor(entity, query.keyOf(last))
        : null,
  };
}

function encodeCursor(entity: AgzScanEntity, keys: SqlValue[]): string {
  return Buffer.from(JSON.stringify({ v: 1, entity, keys }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(entity: AgzScanEntity, cursor: string): SqlValue[] {
  const expectedKeys = ENTITY_KEY_COUNTS[entity];
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("cursor shape");
    }
    const record = parsed as {
      v?: unknown;
      entity?: unknown;
      keys?: unknown;
    };
    if (
      record.v !== 1 ||
      record.entity !== entity ||
      !Array.isArray(record.keys) ||
      record.keys.length !== expectedKeys ||
      !record.keys.every(
        (key) => typeof key === "string" || typeof key === "number",
      )
    ) {
      throw new Error("cursor shape");
    }
    return record.keys as SqlValue[];
  } catch {
    throw new AgzSourceError(
      "invalid_cursor",
      `geçersiz ${entity} cursor değeri`,
      { entity },
    );
  }
}

function resolveBatchSize(value: number | undefined): number {
  return resolveLimit(value, AGZ_INVENTORY_DEFAULT_BATCH_SIZE);
}

function resolveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), AGZ_INVENTORY_MAX_BATCH_SIZE);
}

function readCounts(
  db: SqliteConnection,
  identity: AgzSourceIdentity,
): AgzInventoryCounts {
  const scalar = (sql: string): number =>
    db.get<{ count: number }>(sql)?.count ?? 0;
  const statusRows = db.all<{ status: string; count: number }>(
    "SELECT status, COUNT(*) AS count FROM notes GROUP BY status",
  );
  const byStatus = new Map(statusRows.map((row) => [row.status, row.count]));
  const predicateRows = db.all<{ predicate: string; count: number }>(
    "SELECT predicate, COUNT(*) AS count FROM note_edges GROUP BY predicate",
  );
  const byPredicate = new Map(
    predicateRows.map((row) => [row.predicate, row.count]),
  );
  const edgesByPredicate = Object.fromEntries(
    PREDICATES.map((predicate) => [predicate, byPredicate.get(predicate) ?? 0]),
  ) as Record<AgzPredicate, number>;
  const captureStateRows = db.all<{ state: string; count: number }>(
    "SELECT state, COUNT(*) AS count FROM capture_events GROUP BY state",
  );
  const byCaptureState = new Map(
    captureStateRows.map((row) => [row.state, row.count]),
  );
  const outboxStateRows = db.all<{ state: string; count: number }>(
    "SELECT state, COUNT(*) AS count FROM index_outbox GROUP BY state",
  );
  const byOutboxState = new Map(
    outboxStateRows.map((row) => [row.state, row.count]),
  );

  return {
    schemaVersion: identity.schemaVersion,
    projects: scalar("SELECT COUNT(*) AS count FROM projects"),
    notes: scalar("SELECT COUNT(*) AS count FROM notes"),
    notesActive: byStatus.get("active") ?? 0,
    notesSuperseded: byStatus.get("superseded") ?? 0,
    notesArchived: byStatus.get("archived") ?? 0,
    notesPinned: scalar("SELECT COUNT(*) AS count FROM notes WHERE pinned = 1"),
    revisions: scalar("SELECT COUNT(*) AS count FROM note_revisions"),
    provenance: scalar("SELECT COUNT(*) AS count FROM note_provenance"),
    edges: scalar("SELECT COUNT(*) AS count FROM note_edges"),
    edgesByPredicate,
    captureEvents: scalar("SELECT COUNT(*) AS count FROM capture_events"),
    captureEventStates: Object.fromEntries(
      CAPTURE_EVENT_STATES.map((state) => [
        state,
        byCaptureState.get(state) ?? 0,
      ]),
    ),
    captureCheckpoints: scalar(
      "SELECT COUNT(*) AS count FROM capture_checkpoints",
    ),
    projectBindings: scalar("SELECT COUNT(*) AS count FROM project_bindings"),
    outbox: scalar("SELECT COUNT(*) AS count FROM index_outbox"),
    outboxStates: Object.fromEntries(
      OUTBOX_STATES.map((state) => [state, byOutboxState.get(state) ?? 0]),
    ),
  };
}

class ReportDigest {
  private readonly hash = createHash("sha256");

  update(entity: string, fields: HashTupleValue[]): void {
    this.hash.update(hashTuple(`agz-dry-run/${entity}`, 1, fields));
  }

  finish(): string {
    return this.hash.digest("hex");
  }
}

function buildReport(context: SourceContext): AgzDryRunReport {
  const { db, identity, batchSize, now } = context;
  const digest = new ReportDigest();
  digest.update("source", [
    1,
    identity.databaseId,
    identity.schemaFingerprint,
    identity.hashPolicy,
    identity.file.sha256,
  ]);

  const counts = readCounts(db, identity);
  const plans = new Map<string, AgzProjectPlan>();
  const issues: AgzReportIssue[] = [];
  const counters = { blocking: 0, warning: 0 };
  let issuesTruncated = false;
  const addIssue = (issue: AgzReportIssue): void => {
    if (issue.severity === "blocking") counters.blocking++;
    else counters.warning++;
    if (issues.length < MAX_REPORT_ISSUES) issues.push(issue);
    else issuesTruncated = true;
  };

  forEachScan(
    (page) => {
      return scanKeyset<ProjectRow, AgzProjectRecord>(
        db,
        "projects",
        page,
        batchSize,
        {
          select:
            "SELECT id, name, normalized_name, created_at, updated_at FROM projects",
          where: "1 = 1",
          orderBy: "id",
          keyColumns: "(id)",
          keyOf: (row) => [row.id],
          map: mapProject,
        },
      );
    },
    batchSize,
    (project) => {
      digest.update("project", [
        project.id,
        project.name,
        project.normalizedName,
        project.createdAt,
        project.updatedAt,
      ]);
      plans.set(project.id, {
        sourceProjectId: project.id,
        sourceName: project.name,
        normalizedName: project.normalizedName,
        noteCount: 0,
        activeCount: 0,
        supersededCount: 0,
        archivedCount: 0,
        pinnedCount: 0,
        revisionCount: 0,
        provenanceCount: 0,
        edgeCount: 0,
      });
    },
  );

  forEachScan(
    (page) => {
      return scanKeyset<NoteRow, AgzNoteRecord>(db, "notes", page, batchSize, {
        select: `SELECT id, project_id, kind, title, summary, content, size_class,
                        pinned, status, supersedes_id, current_revision, subject_key,
                        content_hash, created_at, updated_at
                   FROM notes`,
        where: "1 = 1",
        orderBy: "project_id, id",
        keyColumns: "(project_id, id)",
        keyOf: (row) => [row.project_id, row.id],
        map: mapNote,
      });
    },
    batchSize,
    (note) => {
      digest.update("note", [
        note.id,
        note.projectId,
        note.kind,
        note.title,
        note.summary,
        note.content,
        note.sizeClass,
        note.pinned,
        note.status,
        note.supersedesId,
        note.currentRevision,
        note.subjectKey,
        note.contentHash,
        note.recomputedContentHash,
        note.createdAt,
        note.updatedAt,
      ]);
      const plan = plans.get(note.projectId);
      if (plan) {
        plan.noteCount++;
        if (note.status === "active") plan.activeCount++;
        else if (note.status === "superseded") plan.supersededCount++;
        else plan.archivedCount++;
        if (note.pinned) plan.pinnedCount++;
      }
      if (!note.contentHashMatches) {
        addIssue({
          code: "note_content_hash_mismatch",
          severity: "blocking",
          entity: "note",
          detail:
            "not içeriği ile kayıtlı content_hash uyuşmuyor; alan karantina gerektirir",
          projectId: note.projectId,
          noteId: note.id,
        });
      }
    },
  );

  forEachScan(
    (page) => {
      return scanKeyset<RevisionRow, AgzRevisionRecord>(
        db,
        "revisions",
        page,
        batchSize,
        {
          select: `SELECT project_id, note_id, revision, kind, title, summary, content,
                          size_class, pinned, status, supersedes_id, subject_key,
                          content_hash, provenance_id, created_at
                     FROM note_revisions`,
          where: "1 = 1",
          orderBy: "project_id, note_id, revision",
          keyColumns: "(project_id, note_id, revision)",
          keyOf: (row) => [row.project_id, row.note_id, row.revision],
          map: mapRevision,
        },
      );
    },
    batchSize,
    (revision) => {
      digest.update("revision", [
        revision.projectId,
        revision.noteId,
        revision.revision,
        revision.kind,
        revision.title,
        revision.summary,
        revision.content,
        revision.sizeClass,
        revision.pinned,
        revision.status,
        revision.supersedesId,
        revision.subjectKey,
        revision.contentHash,
        revision.recomputedContentHash,
        revision.provenanceId,
        revision.createdAt,
      ]);
      const plan = plans.get(revision.projectId);
      if (plan) plan.revisionCount++;
      if (!revision.contentHashMatches) {
        addIssue({
          code: "revision_content_hash_mismatch",
          severity: "blocking",
          entity: "revision",
          detail:
            "revision içeriği ile kayıtlı content_hash uyuşmuyor; eski hash yeni hash gibi yazılmaz",
          projectId: revision.projectId,
          noteId: revision.noteId,
          revision: revision.revision,
        });
      }
    },
  );

  forEachScan(
    (page) => {
      return scanKeyset<EdgeRow, AgzEdgeRecord>(db, "edges", page, batchSize, {
        select: `SELECT id, project_id, source_id, target_id, predicate, created_at
                   FROM note_edges`,
        where: "1 = 1",
        orderBy: "project_id, id",
        keyColumns: "(project_id, id)",
        keyOf: (row) => [row.project_id, row.id],
        map: (row) => ({
          id: row.id,
          projectId: row.project_id,
          sourceId: row.source_id,
          targetId: row.target_id,
          predicate: row.predicate as AgzPredicate,
          createdAt: row.created_at,
        }),
      });
    },
    batchSize,
    (edge) => {
      digest.update("edge", [
        edge.id,
        edge.projectId,
        edge.sourceId,
        edge.targetId,
        edge.predicate,
        edge.createdAt,
      ]);
      const plan = plans.get(edge.projectId);
      if (plan) plan.edgeCount++;
    },
  );

  forEachScan(
    (page) => {
      return scanKeyset<ProvenanceRow, AgzProvenanceRecord>(
        db,
        "provenance",
        page,
        batchSize,
        {
          select: `SELECT id, project_id, note_id, source_type, capture_event_id,
                          source_session_id, source_message_id, source_ordinal,
                          source_tool_call_id, redaction_version, extractor_version,
                          confidence, created_at
                     FROM note_provenance`,
          where: "1 = 1",
          orderBy: "project_id, id",
          keyColumns: "(project_id, id)",
          keyOf: (row) => [row.project_id, row.id],
          map: (row) => ({
            id: row.id,
            projectId: row.project_id,
            noteId: row.note_id,
            sourceType: row.source_type,
            captureEventId: row.capture_event_id,
            sourceSessionId: row.source_session_id,
            sourceMessageId: row.source_message_id,
            sourceOrdinal: row.source_ordinal,
            sourceToolCallId: row.source_tool_call_id,
            redactionVersion: row.redaction_version,
            extractorVersion: row.extractor_version,
            confidence: row.confidence,
            createdAt: row.created_at,
          }),
        },
      );
    },
    batchSize,
    (provenance) => {
      digest.update("provenance", [
        provenance.id,
        provenance.projectId,
        provenance.noteId,
        provenance.sourceType,
        provenance.captureEventId,
        provenance.sourceSessionId,
        provenance.sourceMessageId,
        provenance.sourceOrdinal,
        provenance.sourceToolCallId,
        provenance.redactionVersion,
        provenance.extractorVersion,
        provenance.confidence,
        provenance.createdAt,
      ]);
      const plan = plans.get(provenance.projectId);
      if (plan) plan.provenanceCount++;
    },
  );

  collectDanglingEdgeIssues(db, batchSize, addIssue);
  collectSupersedesIssues(db, batchSize, addIssue);
  collectProvenanceIssues(db, batchSize, addIssue);
  collectRevisionProvenanceIssues(db, batchSize, addIssue);
  collectRevisionGapIssues(db, batchSize, addIssue);
  collectNoteWithoutProvenanceIssues(db, batchSize, addIssue);

  const sortedIssues = [...issues].sort((left, right) =>
    compareStrings(issueSortKey(left), issueSortKey(right)),
  );
  const projectPlans = [...plans.values()].sort((left, right) =>
    compareStrings(left.sourceProjectId, right.sourceProjectId),
  );
  const totals: AgzPlanTotals = {
    projects: counts.projects,
    notes: counts.notes,
    active: counts.notesActive,
    superseded: counts.notesSuperseded,
    archived: counts.notesArchived,
    pinned: counts.notesPinned,
    revisions: counts.revisions,
    provenance: counts.provenance,
    edges: counts.edges,
  };

  return {
    kind: "agz-memory-dry-run",
    reportVersion: AGZ_INVENTORY_REPORT_VERSION,
    generatedAt: now(),
    dryRun: true,
    source: identity,
    counts,
    plan: { totals, projects: projectPlans },
    digest: digest.finish(),
    issues: sortedIssues,
    issuesTruncated,
    exclusions: buildExclusions(counts),
    decision: {
      status: counters.blocking > 0 ? "blocked" : "ready",
      blockingIssues: counters.blocking,
      warningIssues: counters.warning,
    },
  };
}

function buildExclusions(counts: AgzInventoryCounts): AgzExclusion[] {
  return [
    {
      table: "capture_events",
      count: counts.captureEvents,
      reason:
        "capture_events not değildir; import sırasında replay edilmez ve payload'ları yeni nota dönüştürülmez",
    },
    {
      table: "index_outbox",
      count: counts.outbox,
      reason:
        "türetilmiş indeks kuyruğu replay edilmez; hedef kendi indeksini kurar",
    },
    {
      table: "project_bindings",
      count: counts.projectBindings,
      reason: "kaynak binding'ler hedef kimliğe veya token yetkisine dönüşmez",
    },
    {
      table: "capture_checkpoints",
      count: counts.captureCheckpoints,
      reason: "uzlaştırma checkpoint'leri kaynağa özgü işletim durumudur",
    },
    {
      table: "notes_fts",
      count: counts.notes,
      reason:
        "FTS projeksiyonu türetilmiştir; hedefte kabul edilen revision'dan yeniden üretilir",
    },
  ];
}

function issueSortKey(issue: AgzReportIssue): string {
  return [
    issue.severity === "blocking" ? "0" : "1",
    issue.entity,
    issue.projectId ?? "",
    issue.noteId ?? "",
    issue.edgeId ?? "",
    issue.provenanceId ?? "",
    String(issue.revision ?? ""),
    issue.code,
  ].join("|");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function forEachScan<Item>(
  scan: (page: AgzPageRequest) => AgzScanPage<Item>,
  batchSize: number,
  onItem: (item: Item) => void,
): void {
  let cursor: string | null = null;
  for (;;) {
    const page = scan({
      cursor,
      limit: batchSize,
    });
    for (const item of page.items) onItem(item);
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

interface CheckQuery<Row> {
  select: string;
  from: string;
  where: string;
  orderBy: string;
  keyColumns: string;
  keyOf: (row: Row) => SqlValue[];
}

function forEachCheckRow<Row>(
  db: SqliteConnection,
  query: CheckQuery<Row>,
  batchSize: number,
  onRow: (row: Row) => void,
): void {
  let cursor: SqlValue[] | null = null;
  for (;;) {
    const condition = cursor
      ? `AND ${query.keyColumns} > (${cursor.map(() => "?").join(", ")})`
      : "";
    const params: SqlValue[] = [...(cursor ?? []), batchSize];
    const rows = db.all<Row>(
      `${query.select} ${query.from} WHERE ${query.where} ${condition} ORDER BY ${query.orderBy} LIMIT ?`,
      params,
    );
    for (const row of rows) onRow(row);
    if (rows.length < batchSize) return;
    cursor = query.keyOf(rows[rows.length - 1]!);
  }
}

function collectDanglingEdgeIssues(
  db: SqliteConnection,
  batchSize: number,
  addIssue: (issue: AgzReportIssue) => void,
): void {
  interface Row {
    id: string;
    project_id: string;
    source_id: string;
    target_id: string;
    source_owner: string | null;
    target_owner: string | null;
  }
  forEachCheckRow<Row>(
    db,
    {
      select: `SELECT id, project_id, source_id, target_id, source_owner, target_owner FROM (
                 SELECT e.id AS id, e.project_id AS project_id, e.source_id AS source_id,
                        e.target_id AS target_id,
                        (SELECT project_id FROM notes WHERE id = e.source_id) AS source_owner,
                        (SELECT project_id FROM notes WHERE id = e.target_id) AS target_owner
                   FROM note_edges e
               )`,
      from: "",
      where: `source_owner IS NULL OR target_owner IS NULL
                OR source_owner != project_id OR target_owner != project_id`,
      orderBy: "project_id, id",
      keyColumns: "(project_id, id)",
      keyOf: (row) => [row.project_id, row.id],
    },
    batchSize,
    (row) => {
      if (row.source_owner === null || row.target_owner === null) {
        addIssue({
          code: "edge_missing_endpoint",
          severity: "blocking",
          entity: "edge",
          detail:
            "edge uçlarından biri aynı projede bulunamadı; referans uydurulmaz",
          projectId: row.project_id,
          edgeId: row.id,
          noteId: row.source_owner === null ? row.source_id : row.target_id,
        });
        return;
      }
      addIssue({
        code: "edge_cross_project",
        severity: "blocking",
        entity: "edge",
        detail:
          "edge uçları farklı projelere ait; açık kapsam kararı olmadan taşınamaz",
        projectId: row.project_id,
        edgeId: row.id,
      });
    },
  );
}

function collectSupersedesIssues(
  db: SqliteConnection,
  batchSize: number,
  addIssue: (issue: AgzReportIssue) => void,
): void {
  interface Row {
    id: string;
    project_id: string;
    supersedes_id: string;
  }
  forEachCheckRow<Row>(
    db,
    {
      select:
        "SELECT n.id AS id, n.project_id AS project_id, n.supersedes_id AS supersedes_id",
      from: `FROM notes n
             LEFT JOIN notes s ON s.project_id = n.project_id AND s.id = n.supersedes_id`,
      where: "n.supersedes_id IS NOT NULL AND s.id IS NULL",
      orderBy: "n.project_id, n.id",
      keyColumns: "(n.project_id, n.id)",
      keyOf: (row) => [row.project_id, row.id],
    },
    batchSize,
    (row) => {
      addIssue({
        code: "supersedes_missing",
        severity: "blocking",
        entity: "note",
        detail:
          "supersedes_id aynı projede bulunamadı; bağ karantina gerektirir",
        projectId: row.project_id,
        noteId: row.id,
      });
    },
  );
}

function collectProvenanceIssues(
  db: SqliteConnection,
  batchSize: number,
  addIssue: (issue: AgzReportIssue) => void,
): void {
  interface Row {
    id: string;
    project_id: string;
    note_id: string;
  }
  forEachCheckRow<Row>(
    db,
    {
      select:
        "SELECT p.id AS id, p.project_id AS project_id, p.note_id AS note_id",
      from: `FROM note_provenance p
             LEFT JOIN notes n ON n.project_id = p.project_id AND n.id = p.note_id`,
      where: "n.id IS NULL",
      orderBy: "p.project_id, p.id",
      keyColumns: "(p.project_id, p.id)",
      keyOf: (row) => [row.project_id, row.id],
    },
    batchSize,
    (row) => {
      addIssue({
        code: "provenance_missing_note",
        severity: "blocking",
        entity: "provenance",
        detail: "provenance kaydının notu aynı projede bulunamadı",
        projectId: row.project_id,
        noteId: row.note_id,
        provenanceId: row.id,
      });
    },
  );
}

function collectRevisionProvenanceIssues(
  db: SqliteConnection,
  batchSize: number,
  addIssue: (issue: AgzReportIssue) => void,
): void {
  interface Row {
    project_id: string;
    note_id: string;
    revision: number;
    provenance_id: string;
  }
  forEachCheckRow<Row>(
    db,
    {
      select: `SELECT r.project_id AS project_id, r.note_id AS note_id,
                      r.revision AS revision, r.provenance_id AS provenance_id`,
      from: `FROM note_revisions r
             LEFT JOIN note_provenance p
               ON p.project_id = r.project_id AND p.id = r.provenance_id`,
      where: "p.id IS NULL",
      orderBy: "r.project_id, r.note_id, r.revision",
      keyColumns: "(r.project_id, r.note_id, r.revision)",
      keyOf: (row) => [row.project_id, row.note_id, row.revision],
    },
    batchSize,
    (row) => {
      addIssue({
        code: "revision_missing_provenance",
        severity: "blocking",
        entity: "revision",
        detail: "revision provenance kaydı bulunamadı",
        projectId: row.project_id,
        noteId: row.note_id,
        revision: row.revision,
        provenanceId: row.provenance_id,
      });
    },
  );
}

function collectRevisionGapIssues(
  db: SqliteConnection,
  batchSize: number,
  addIssue: (issue: AgzReportIssue) => void,
): void {
  interface Row {
    id: string;
    project_id: string;
    current_revision: number;
    revision_count: number;
    max_revision: number;
  }
  forEachCheckRow<Row>(
    db,
    {
      select: `SELECT id, project_id, current_revision, revision_count, max_revision FROM (
                 SELECT n.id AS id, n.project_id AS project_id,
                        n.current_revision AS current_revision,
                        COALESCE(r.revision_count, 0) AS revision_count,
                        COALESCE(r.max_revision, 0) AS max_revision
                   FROM notes n
                   LEFT JOIN (
                     SELECT project_id, note_id,
                            COUNT(*) AS revision_count,
                            MAX(revision) AS max_revision
                       FROM note_revisions
                      GROUP BY project_id, note_id
                   ) r ON r.project_id = n.project_id AND r.note_id = n.id
               )`,
      from: "",
      where:
        "revision_count != current_revision OR max_revision != current_revision",
      orderBy: "project_id, id",
      keyColumns: "(project_id, id)",
      keyOf: (row) => [row.project_id, row.id],
    },
    batchSize,
    (row) => {
      if (row.revision_count === 0) {
        addIssue({
          code: "note_missing_revisions",
          severity: "blocking",
          entity: "note",
          detail:
            "notun hiç revision kaydı yok; geçmiş kaynağından yeniden kurulamaz",
          projectId: row.project_id,
          noteId: row.id,
        });
        return;
      }
      addIssue({
        code: "revision_gap",
        severity: "blocking",
        entity: "note",
        detail: `current_revision ${row.current_revision} ile revision kayıtları (${row.revision_count} adet, en yüksek ${row.max_revision}) uyuşmuyor`,
        projectId: row.project_id,
        noteId: row.id,
        revision: row.current_revision,
      });
    },
  );
}

function collectNoteWithoutProvenanceIssues(
  db: SqliteConnection,
  batchSize: number,
  addIssue: (issue: AgzReportIssue) => void,
): void {
  interface Row {
    id: string;
    project_id: string;
  }
  forEachCheckRow<Row>(
    db,
    {
      select: "SELECT n.id AS id, n.project_id AS project_id",
      from: `FROM notes n
             LEFT JOIN note_provenance p
               ON p.project_id = n.project_id AND p.note_id = n.id`,
      where: "p.id IS NULL",
      orderBy: "n.project_id, n.id",
      keyColumns: "(n.project_id, n.id)",
      keyOf: (row) => [row.project_id, row.id],
    },
    batchSize,
    (row) => {
      addIssue({
        code: "note_without_provenance",
        severity: "warning",
        entity: "note",
        detail:
          "notun provenance kaydı yok; kaynak izi uydurulmaz, karar raporlanır",
        projectId: row.project_id,
        noteId: row.id,
      });
    },
  );
}
