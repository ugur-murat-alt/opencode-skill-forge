/**
 * #40 (M07) FAZ 2: dondurulmuş AGZ import manifest sözleşmesi.
 *
 * Manifest yalnız kimlik, eşleme, hash, sayım, karar ve gerekçe taşır; not
 * `content`/`summary` metni, ham transcript, token veya mutlak kaynak yolu
 * taşımaz. Açık `AGZ proje UUID → hedef tenant/memory_space/proje UUID`
 * eşlemesi zorunludur; ad benzerliği eşleme değildir.
 *
 * Kimlik politikası: hedefte çakışma yoksa not UUID'si korunur. Aynı UUID
 * başka bir kaynak veritabanına/nota aitse deterministik türetilmiş UUID
 * kullanılır ve manifestte `remapped` olarak raporlanır.
 */

import { z } from "zod";
import type { Kysely } from "kysely";
import type { Identity } from "../../application/identity.js";
import { ForgeError } from "../../domain/errors.js";
import {
  MEMORY_KINDS,
  MEMORY_RELATIONS,
  type MemoryRelation,
} from "../../domain/memory.js";
import type { DB } from "../../storage/schema.js";
import { MemoryService } from "../service.js";
import { safeJoin } from "../paths.js";
import { serializeAgzDocument } from "./documents.js";
import { hashTuple } from "./hash.js";
import type {
  AgzExclusion,
  AgzNoteRecord,
  AgzPredicate,
  AgzProvenanceRecord,
  AgzRevisionRecord,
  AgzEdgeRecord,
  AgzScanPage,
  AgzSource,
} from "./inventory.js";

export const AGZ_MANIFEST_VERSION = 1 as const;
export const AGZ_SOURCE_VERSION = "0.5.2" as const;
export const AGZ_SOURCE_COMMIT =
  "80096abaaa66dfb13953d011ad234859a75df222" as const;
/** AGZ revision'ları hedefte kesintisiz 1..N hedeflenir; gerçek değer receipt'te. */
export const AGZ_IMPORT_SOURCE_KIND = "migration" as const;
const AGZ_PREDICATES = [
  "SUPPORTS",
  "DERIVED_FROM",
  "PART_OF",
  "ABOUT",
  "PRECEDES",
  "SUPERSEDES",
] as const;
const MAX_MANIFEST_EDGES = 200;
const SCAN_BATCH = 500;

export type AgzManifestDecisionStatus = "ready" | "partial" | "blocked";

export interface AgzSourceSnapshotIdentity {
  productId: string;
  version: string;
  commit: string;
  schemaVersion: number;
  hashPolicy: string;
  schemaFingerprint: string;
  databaseId: string;
  fileSha256: string;
  fileSizeBytes: number;
  inventoryDigest: string;
  journalMode: string;
  integrityCheck: string;
}

export interface AgzTargetBinding {
  tenantId: string;
  memorySpaceId: string;
  projectId: string | null;
  kind: "personal" | "project" | "organization";
}

export interface AgzProjectMapping {
  sourceProjectId: string;
  sourceName: string;
  normalizedName: string;
  target: AgzTargetBinding;
}

export interface AgzManifestRevision {
  sourceRevision: number;
  /** AGZ `hash-tuple/2` içerik hash'i; hedef hash yerine geçmez. */
  sourceContentHash: string;
  /** Planlanan hedef revision (kaynak sırası, 1 tabanlı). */
  targetRevision: number;
  documentSha256: string;
  recordHash: string;
  bytes: number;
}

export interface AgzManifestEdge {
  relation: MemoryRelation;
  sourceRelation: AgzPredicate;
  targetSourceNoteId: string;
  targetNoteId: string;
}

export interface AgzManifestIssue {
  code: string;
  severity: "blocking" | "warning";
  detail: string;
  sourceProjectId?: string;
  sourceNoteId?: string;
  edgeId?: string;
}

export interface AgzManifestNote {
  sourceProjectId: string;
  sourceNoteId: string;
  targetNoteId: string;
  idDecision: "preserved" | "remapped";
  idDecisionReason: string | null;
  title: string;
  kind: string;
  lifecycle: string;
  pinned: boolean;
  status: "ready" | "quarantined";
  issues: AgzManifestIssue[];
  revisions: AgzManifestRevision[];
  edges: AgzManifestEdge[];
  provenanceCount: number;
}

export interface AgzManifestCounts {
  projects: number;
  notes: number;
  readyNotes: number;
  quarantinedNotes: number;
  revisions: number;
  edges: number;
  droppedEdges: number;
  provenance: number;
  pinned: number;
}

export interface AgzImportManifest {
  manifestVersion: typeof AGZ_MANIFEST_VERSION;
  kind: "agz-memory-import-manifest";
  createdAt: number;
  generator: { product: string; module: "m07-agz-import" };
  source: AgzSourceSnapshotIdentity;
  mappings: AgzProjectMapping[];
  notes: AgzManifestNote[];
  counts: AgzManifestCounts;
  exclusions: AgzExclusion[];
  issues: AgzManifestIssue[];
  decision: {
    status: AgzManifestDecisionStatus;
    blockingIssues: number;
    warningIssues: number;
  };
}

export interface AgzStageDocument {
  sourceProjectId: string;
  sourceNoteId: string;
  sourceRevision: number;
  relativePath: string;
  content: string;
  sha256: string;
  bytes: number;
}

export interface AgzImportPlan {
  manifest: AgzImportManifest;
  documents: AgzStageDocument[];
}

export interface PlanAgzImportInput {
  source: AgzSource;
  targetDb: Kysely<DB>;
  mappings: readonly AgzProjectMapping[];
  now?: () => number;
}

export interface EnsureAgzTargetSpaceInput {
  service: MemoryService;
  identity: Identity;
  sourceProjectId: string;
  sourceName: string;
  normalizedName: string;
  kind: "personal" | "project" | "organization";
  projectId?: string | null;
  organizationName?: string;
}

// ---------------------------------------------------------------------------
// Şema
// ---------------------------------------------------------------------------

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const idSchema = z.string().min(1).max(200);

const targetBindingSchema = z
  .object({
    tenantId: idSchema,
    memorySpaceId: idSchema,
    projectId: idSchema.nullable(),
    kind: z.enum(["personal", "project", "organization"]),
  })
  .strict();

const mappingSchema = z
  .object({
    sourceProjectId: idSchema,
    sourceName: z.string().min(1).max(500),
    normalizedName: z.string().min(1).max(500),
    target: targetBindingSchema,
  })
  .strict();

const manifestRevisionSchema = z
  .object({
    sourceRevision: z.number().int().min(1),
    sourceContentHash: sha256Schema,
    targetRevision: z.number().int().min(1),
    documentSha256: sha256Schema,
    recordHash: sha256Schema,
    bytes: z.number().int().min(1),
  })
  .strict();

const manifestEdgeSchema = z
  .object({
    relation: z.enum(MEMORY_RELATIONS),
    sourceRelation: z.enum(AGZ_PREDICATES),
    targetSourceNoteId: idSchema,
    targetNoteId: idSchema,
  })
  .strict();

const manifestIssueSchema = z
  .object({
    code: z.string().min(1).max(80),
    severity: z.enum(["blocking", "warning"]),
    detail: z.string().min(1).max(1000),
    sourceProjectId: idSchema.optional(),
    sourceNoteId: idSchema.optional(),
    edgeId: idSchema.optional(),
  })
  .strict();

const manifestNoteSchema = z
  .object({
    sourceProjectId: idSchema,
    sourceNoteId: idSchema,
    targetNoteId: idSchema,
    idDecision: z.enum(["preserved", "remapped"]),
    idDecisionReason: z.string().max(500).nullable(),
    title: z.string().min(1).max(500),
    kind: z.enum(MEMORY_KINDS),
    lifecycle: z.enum(["active", "superseded", "archived"]),
    pinned: z.boolean(),
    status: z.enum(["ready", "quarantined"]),
    issues: z.array(manifestIssueSchema).max(100),
    revisions: z.array(manifestRevisionSchema).max(10_000),
    edges: z.array(manifestEdgeSchema).max(MAX_MANIFEST_EDGES),
    provenanceCount: z.number().int().min(0),
  })
  .strict();

const exclusionSchema = z
  .object({
    table: z.string().min(1).max(80),
    count: z.number().int().min(0),
    reason: z.string().min(1).max(500),
  })
  .strict();

const manifestSchema = z
  .object({
    manifestVersion: z.literal(AGZ_MANIFEST_VERSION),
    kind: z.literal("agz-memory-import-manifest"),
    createdAt: z.number().int().min(0),
    generator: z
      .object({
        product: z.string().min(1).max(200),
        module: z.literal("m07-agz-import"),
      })
      .strict(),
    source: z
      .object({
        productId: z.literal("agz-memory"),
        version: z.string().min(1).max(40),
        commit: z.string().min(1).max(80),
        schemaVersion: z.literal(11),
        hashPolicy: z.literal("hash-tuple/2"),
        schemaFingerprint: sha256Schema,
        databaseId: idSchema,
        fileSha256: sha256Schema,
        fileSizeBytes: z.number().int().min(0),
        inventoryDigest: sha256Schema,
        journalMode: z.string().min(1).max(40),
        integrityCheck: z.string().min(1).max(40),
      })
      .strict(),
    mappings: z.array(mappingSchema).min(1).max(10_000),
    notes: z.array(manifestNoteSchema).max(1_000_000),
    counts: z
      .object({
        projects: z.number().int().min(0),
        notes: z.number().int().min(0),
        readyNotes: z.number().int().min(0),
        quarantinedNotes: z.number().int().min(0),
        revisions: z.number().int().min(0),
        edges: z.number().int().min(0),
        droppedEdges: z.number().int().min(0),
        provenance: z.number().int().min(0),
        pinned: z.number().int().min(0),
      })
      .strict(),
    exclusions: z.array(exclusionSchema).max(100),
    issues: z.array(manifestIssueSchema).max(100_000),
    decision: z
      .object({
        status: z.enum(["ready", "partial", "blocked"]),
        blockingIssues: z.number().int().min(0),
        warningIssues: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Kimlik yardımcıları
// ---------------------------------------------------------------------------

export function deterministicAgzNoteId(
  databaseId: string,
  sourceProjectId: string,
  sourceNoteId: string,
): string {
  const digest = hashTuple("agz-import-note-id", 1, [
    databaseId,
    sourceProjectId,
    sourceNoteId,
  ]);
  const hex = digest.slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export function agzIdempotencyKey(
  databaseId: string,
  sourceProjectId: string,
  sourceNoteId: string,
  revision: number,
): string {
  return `agz:${databaseId}:${sourceProjectId}:${sourceNoteId}:${revision}`;
}

export function computeAgzStageDigest(manifest: AgzImportManifest): string {
  const entries: string[] = [];
  for (const note of [...manifest.notes].sort((left, right) =>
    left.sourceNoteId < right.sourceNoteId
      ? -1
      : left.sourceNoteId > right.sourceNoteId
        ? 1
        : 0,
  )) {
    for (const revision of note.revisions) {
      entries.push(
        `${note.sourceProjectId}|${note.sourceNoteId}|${revision.sourceRevision}|${revision.documentSha256}`,
      );
    }
  }
  return hashTuple("agz-import-stage", 1, [
    manifest.source.databaseId,
    manifest.source.fileSha256,
    ...entries,
  ]);
}

export function agzStageDir(
  vaultRootPath: string,
  manifest: AgzImportManifest,
): string {
  return safeJoin(
    vaultRootPath,
    "imports",
    manifest.source.databaseId,
    manifest.source.fileSha256,
  );
}

export function agzDocumentRelativePath(
  sourceNoteId: string,
  sourceRevision: number,
  documentSha256: string,
): string {
  return `documents/${sourceNoteId}/${sourceRevision}-${documentSha256}.md`;
}

// ---------------------------------------------------------------------------
// Doğrulama
// ---------------------------------------------------------------------------

export function verifyAgzManifest(value: unknown): AgzImportManifest {
  const version = (value as { manifestVersion?: unknown } | null)
    ?.manifestVersion;
  if (version !== AGZ_MANIFEST_VERSION)
    throw new ForgeError(
      "unsupported_manifest",
      "Desteklenmeyen AGZ import manifest sürümü.",
      422,
      undefined,
      { found: version ?? null, supported: AGZ_MANIFEST_VERSION },
    );
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success)
    throw new ForgeError(
      "invalid_agz_manifest",
      "AGZ import manifest şeması geçersiz.",
      422,
      undefined,
      {
        issues: parsed.error.issues
          .slice(0, 10)
          .map(
            (issue) =>
              `${issue.path.join(".") || "manifest"}: ${issue.message}`,
          ),
      },
    );
  return parsed.data as AgzImportManifest;
}

export function parseAgzManifestJson(text: string): AgzImportManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ForgeError(
      "invalid_agz_manifest",
      "AGZ import manifest JSON olarak okunamadı.",
      422,
    );
  }
  return verifyAgzManifest(value);
}

export function agzManifestJson(manifest: AgzImportManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Hedef alan bağlama
// ---------------------------------------------------------------------------

export async function ensureAgzTargetSpace(
  input: EnsureAgzTargetSpaceInput,
): Promise<AgzProjectMapping> {
  let space;
  if (input.kind === "personal") {
    space = await input.service.ensureSpace(input.identity, {
      type: "personal",
    });
  } else if (input.kind === "project") {
    if (!input.projectId)
      throw new ForgeError(
        "invalid_agz_mapping",
        "Proje eşlemesi için hedef projectId zorunludur.",
        422,
      );
    space = await input.service.ensureSpace(input.identity, {
      type: "project",
      projectId: input.projectId,
    });
  } else {
    space = await input.service.createOrganizationSpace(
      input.identity,
      input.organizationName?.trim() || input.sourceName,
    );
  }
  return {
    sourceProjectId: input.sourceProjectId,
    sourceName: input.sourceName,
    normalizedName: input.normalizedName,
    target: {
      tenantId: input.identity.tenantId,
      memorySpaceId: space.id,
      projectId: space.project_id,
      kind: space.kind,
    },
  };
}

// ---------------------------------------------------------------------------
// Plan üretimi
// ---------------------------------------------------------------------------

interface AgzTables {
  projects: Array<{ id: string; name: string; normalizedName: string }>;
  notes: AgzNoteRecord[];
  revisions: AgzRevisionRecord[];
  provenance: AgzProvenanceRecord[];
  edges: AgzEdgeRecord[];
}

function collectPages<Item>(
  scan: (page: { cursor?: string | null; limit?: number }) => AgzScanPage<Item>,
): Item[] {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = scan({ cursor, limit: SCAN_BATCH });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
}

function readAgzTables(source: AgzSource): AgzTables {
  return {
    projects: collectPages((page) => source.scanProjects(page)).map(
      (project) => ({
        id: project.id,
        name: project.name,
        normalizedName: project.normalizedName,
      }),
    ),
    notes: collectPages((page) => source.scanNotes(page)),
    revisions: collectPages((page) => source.scanRevisions(page)),
    provenance: collectPages((page) => source.scanProvenance(page)),
    edges: collectPages((page) => source.scanEdges(page)),
  };
}

interface TargetNoteState {
  exists: boolean;
  owned: boolean;
  deleted: boolean;
}

async function targetNoteState(
  db: Kysely<DB>,
  mapping: AgzProjectMapping,
  databaseId: string,
  noteId: string,
): Promise<TargetNoteState> {
  const note = await db
    .selectFrom("memory_notes")
    .select(["id", "deleted_at"])
    .where("tenant_id", "=", mapping.target.tenantId)
    .where("space_id", "=", mapping.target.memorySpaceId)
    .where("id", "=", noteId)
    .executeTakeFirst();
  if (!note) return { exists: false, owned: false, deleted: false };
  const event = await db
    .selectFrom("memory_events")
    .select(["id"])
    .where("tenant_id", "=", mapping.target.tenantId)
    .where("space_id", "=", mapping.target.memorySpaceId)
    .where("note_id", "=", noteId)
    .where("source_event_key", "like", `agz:${databaseId}:%`)
    .executeTakeFirst();
  return {
    exists: true,
    owned: Boolean(event),
    deleted: note.deleted_at !== null,
  };
}

interface ResolvedTargetId {
  targetNoteId: string;
  idDecision: "preserved" | "remapped";
  reason: string | null;
  conflict: boolean;
}

async function resolveTargetNoteId(
  db: Kysely<DB>,
  mapping: AgzProjectMapping,
  databaseId: string,
  note: AgzNoteRecord,
): Promise<ResolvedTargetId> {
  const candidate = await targetNoteState(db, mapping, databaseId, note.id);
  if (!candidate.exists || candidate.owned)
    return {
      targetNoteId: note.id,
      idDecision: "preserved",
      reason: null,
      conflict: false,
    };
  const remappedId = deterministicAgzNoteId(
    databaseId,
    mapping.sourceProjectId,
    note.id,
  );
  const remapped = await targetNoteState(db, mapping, databaseId, remappedId);
  if (!remapped.exists || remapped.owned)
    return {
      targetNoteId: remappedId,
      idDecision: "remapped",
      reason: `hedefte ${note.id} başka bir kaynağa ait`,
      conflict: false,
    };
  return {
    targetNoteId: remappedId,
    idDecision: "remapped",
    reason: "türetilmiş kimlik de başka bir kaynağa ait",
    conflict: true,
  };
}

function issue(
  code: string,
  severity: "blocking" | "warning",
  detail: string,
  extra: Partial<AgzManifestIssue> = {},
): AgzManifestIssue {
  return { code, severity, detail, ...extra };
}

export async function planAgzImport(
  input: PlanAgzImportInput,
): Promise<AgzImportPlan> {
  const now = input.now ?? Date.now;
  const report = input.source.buildDryRunReport();
  const identity: AgzSourceSnapshotIdentity = {
    productId: report.source.productId,
    version: AGZ_SOURCE_VERSION,
    commit: AGZ_SOURCE_COMMIT,
    schemaVersion: report.source.schemaVersion,
    hashPolicy: report.source.hashPolicy,
    schemaFingerprint: report.source.schemaFingerprint,
    databaseId: report.source.databaseId,
    fileSha256: report.source.file.sha256,
    fileSizeBytes: report.source.file.sizeBytes,
    inventoryDigest: report.digest,
    journalMode: report.source.journalMode,
    integrityCheck: report.source.integrityCheck,
  };
  const tables = readAgzTables(input.source);

  const mappingByProject = new Map<string, AgzProjectMapping>();
  for (const mapping of input.mappings) {
    if (mappingByProject.has(mapping.sourceProjectId))
      throw new ForgeError(
        "invalid_agz_mapping",
        `Kaynak proje birden çok kez eşlenmiş: ${mapping.sourceProjectId}`,
        422,
      );
    mappingByProject.set(mapping.sourceProjectId, mapping);
  }

  const revisionsByNote = new Map<string, AgzRevisionRecord[]>();
  for (const revision of tables.revisions) {
    const list = revisionsByNote.get(revision.noteId) ?? [];
    list.push(revision);
    revisionsByNote.set(revision.noteId, list);
  }
  for (const list of revisionsByNote.values())
    list.sort((left, right) => left.revision - right.revision);
  const provenanceById = new Map(
    tables.provenance.map((entry) => [entry.id, entry]),
  );
  const edgesBySource = new Map<string, AgzEdgeRecord[]>();
  for (const edge of tables.edges) {
    const list = edgesBySource.get(edge.sourceId) ?? [];
    list.push(edge);
    edgesBySource.set(edge.sourceId, list);
  }

  const topLevelIssues: AgzManifestIssue[] = [];
  for (const project of tables.projects) {
    if (mappingByProject.has(project.id)) continue;
    const hasNotes = tables.notes.some((note) => note.projectId === project.id);
    topLevelIssues.push(
      hasNotes
        ? issue(
            "unmapped_project",
            "blocking",
            `Kaynak proje için açık hedef eşlemesi yok: ${project.name}`,
            { sourceProjectId: project.id },
          )
        : issue(
            "unmapped_project_empty",
            "warning",
            `Kaynak proje eşlenmemiş ve hiç notu yok: ${project.name}`,
            { sourceProjectId: project.id },
          ),
    );
  }

  const sortedNotes = [...tables.notes].sort((left, right) =>
    left.projectId < right.projectId
      ? -1
      : left.projectId > right.projectId
        ? 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
  );

  interface PendingNote {
    note: AgzNoteRecord;
    mapping: AgzProjectMapping | null;
    target: ResolvedTargetId | null;
    issues: AgzManifestIssue[];
    provenance: AgzProvenanceRecord[];
  }
  const pending: PendingNote[] = [];

  for (const note of sortedNotes) {
    const issues: AgzManifestIssue[] = [];
    const mapping = mappingByProject.get(note.projectId) ?? null;
    if (!mapping) {
      issues.push(
        issue(
          "unmapped_project",
          "blocking",
          "Notun projesi için açık hedef eşlemesi yok.",
          { sourceProjectId: note.projectId, sourceNoteId: note.id },
        ),
      );
    }
    if (!note.contentHashMatches)
      issues.push(
        issue(
          "note_content_hash_mismatch",
          "blocking",
          "Not içeriği ile kayıtlı AGZ content_hash uyuşmuyor.",
          { sourceProjectId: note.projectId, sourceNoteId: note.id },
        ),
      );
    const revisions = revisionsByNote.get(note.id) ?? [];
    if (revisions.length === 0)
      issues.push(
        issue(
          "note_missing_revisions",
          "blocking",
          "Notun hiç revision kaydı yok.",
          { sourceProjectId: note.projectId, sourceNoteId: note.id },
        ),
      );
    else if (
      revisions.length !== note.currentRevision ||
      revisions[revisions.length - 1]!.revision !== note.currentRevision
    )
      issues.push(
        issue(
          "revision_gap",
          "blocking",
          `current_revision ${note.currentRevision} ile revision kayıtları uyuşmuyor.`,
          { sourceProjectId: note.projectId, sourceNoteId: note.id },
        ),
      );
    const attachedProvenance: AgzProvenanceRecord[] = [];
    for (const revision of revisions) {
      if (!revision.contentHashMatches)
        issues.push(
          issue(
            "revision_content_hash_mismatch",
            "blocking",
            `Revision ${revision.revision} içeriği ile hash uyuşmuyor.`,
            { sourceProjectId: note.projectId, sourceNoteId: note.id },
          ),
        );
      const entry = provenanceById.get(revision.provenanceId);
      if (!entry)
        issues.push(
          issue(
            "revision_missing_provenance",
            "blocking",
            `Revision ${revision.revision} provenance kaydı bulunamadı.`,
            {
              sourceProjectId: note.projectId,
              sourceNoteId: note.id,
            },
          ),
        );
      else attachedProvenance.push(entry);
    }
    if (attachedProvenance.length === 0 && revisions.length > 0)
      issues.push(
        issue(
          "note_without_provenance",
          "warning",
          "Notun provenance kaydı yok; kaynak izi uydurulmaz.",
          { sourceProjectId: note.projectId, sourceNoteId: note.id },
        ),
      );

    let target: ResolvedTargetId | null = null;
    if (mapping && !issues.some((entry) => entry.severity === "blocking")) {
      target = await resolveTargetNoteId(
        input.targetDb,
        mapping,
        identity.databaseId,
        note,
      );
      if (target.conflict)
        issues.push(
          issue(
            "note_id_conflict",
            "blocking",
            "Kaynak ve türetilmiş hedef not kimliği başka bir kaynağa ait.",
            { sourceProjectId: note.projectId, sourceNoteId: note.id },
          ),
        );
      const state = await targetNoteState(
        input.targetDb,
        mapping,
        identity.databaseId,
        target.targetNoteId,
      );
      if (state.deleted)
        issues.push(
          issue(
            "target_note_deleted",
            "blocking",
            "Hedef not tombstone durumunda; önce açık restore gerekir.",
            { sourceProjectId: note.projectId, sourceNoteId: note.id },
          ),
        );
    }

    pending.push({
      note,
      mapping,
      target,
      issues,
      provenance: attachedProvenance,
    });
  }

  // Belgeler yalnız bloklayıcı sorunu olmayan notlar için doğrulanır; belge
  // sözleşmeye dönüşmezse not karantinaya alınır. Edge'ler tüm not
  // durumları netleştikten sonra ikinci geçişte eklenir (frontmatter'daki
  // edges eşlenmiş hedef kimlikleri taşır).
  const readyIds = new Set<string>();
  for (const entry of pending) {
    if (entry.issues.some((item) => item.severity === "blocking")) continue;
    if (!entry.mapping || !entry.target) continue;
    const revisions = revisionsByNote.get(entry.note.id) ?? [];
    let failed = false;
    for (const revision of revisions) {
      const provenance = provenanceById.get(revision.provenanceId);
      try {
        serializeAgzDocument({
          databaseId: identity.databaseId,
          sourceProjectId: entry.note.projectId,
          sourceNoteId: entry.note.id,
          targetNoteId: entry.target.targetNoteId,
          spaceId: entry.mapping.target.memorySpaceId,
          note: entry.note,
          revision,
          provenance: provenance ? [provenance] : [],
          edges: [],
        });
      } catch (error) {
        failed = true;
        entry.issues.push(
          issue(
            "invalid_agz_document",
            "blocking",
            `Belge dönüşümü başarısız: ${error instanceof Error ? error.message : String(error)}`,
            {
              sourceProjectId: entry.note.projectId,
              sourceNoteId: entry.note.id,
            },
          ),
        );
        break;
      }
    }
    if (!failed) readyIds.add(entry.note.id);
  }

  // Edge'ler yalnız hazır notlar arasında ve hazır hedeflere kurulur.
  const targetIdBySource = new Map<string, string>();
  for (const entry of pending)
    if (readyIds.has(entry.note.id) && entry.target)
      targetIdBySource.set(entry.note.id, entry.target.targetNoteId);
  const droppedEdges: AgzManifestIssue[] = [];
  const edgesByReadyNote = new Map<string, AgzManifestEdge[]>();
  const sourceProjectByNote = new Map(
    tables.notes.map((note) => [note.id, note.projectId]),
  );
  for (const entry of pending) {
    if (!readyIds.has(entry.note.id)) {
      // Karantinaya alınan notun edge'leri de taşınmaz ve açıkça raporlanır.
      for (const edge of edgesBySource.get(entry.note.id) ?? [])
        droppedEdges.push(
          issue(
            "edge_source_quarantined",
            "warning",
            `Edge kaynağı karantinada: ${edge.predicate}`,
            {
              sourceProjectId: entry.note.projectId,
              sourceNoteId: entry.note.id,
              edgeId: edge.id,
            },
          ),
        );
      continue;
    }
    const note = entry.note;
    const mapped: AgzManifestEdge[] = [];
    for (const edge of edgesBySource.get(note.id) ?? []) {
      const targetProject = sourceProjectByNote.get(edge.targetId);
      if (!targetProject || targetProject !== note.projectId) {
        droppedEdges.push(
          issue(
            "edge_cross_project",
            "warning",
            `Edge uçları farklı projelerde veya hedef yok: ${edge.predicate}`,
            {
              sourceProjectId: note.projectId,
              sourceNoteId: note.id,
              edgeId: edge.id,
            },
          ),
        );
        continue;
      }
      const targetId = targetIdBySource.get(edge.targetId);
      if (!targetId) {
        droppedEdges.push(
          issue(
            "edge_target_unavailable",
            "warning",
            `Edge hedefi hazır değil: ${edge.predicate}`,
            {
              sourceProjectId: note.projectId,
              sourceNoteId: note.id,
              edgeId: edge.id,
            },
          ),
        );
        continue;
      }
      mapped.push({
        relation: edge.predicate as MemoryRelation,
        sourceRelation: edge.predicate,
        targetSourceNoteId: edge.targetId,
        targetNoteId: targetId,
      });
    }
    if (note.supersedesId && targetIdBySource.has(note.supersedesId)) {
      const exists = mapped.some(
        (edge) =>
          edge.relation === "SUPERSEDES" &&
          edge.targetSourceNoteId === note.supersedesId,
      );
      if (!exists)
        mapped.push({
          relation: "SUPERSEDES",
          sourceRelation: "SUPERSEDES",
          targetSourceNoteId: note.supersedesId,
          targetNoteId: targetIdBySource.get(note.supersedesId)!,
        });
    } else if (note.supersedesId) {
      droppedEdges.push(
        issue(
          "supersedes_missing",
          "warning",
          "supersedes_id hedefi hazır notlar arasında yok; bağ taşınmadı.",
          {
            sourceProjectId: note.projectId,
            sourceNoteId: note.id,
          },
        ),
      );
    }
    const deduped = new Map<string, AgzManifestEdge>();
    for (const edge of mapped)
      deduped.set(`${edge.relation}\u0000${edge.targetNoteId}`, edge);
    let list = [...deduped.values()];
    if (list.length > MAX_MANIFEST_EDGES) {
      droppedEdges.push(
        issue(
          "edge_limit_truncated",
          "warning",
          `Edge sayısı ${MAX_MANIFEST_EDGES} sınırını aştı; fazlası taşınmadı.`,
          { sourceProjectId: note.projectId, sourceNoteId: note.id },
        ),
      );
      list = list.slice(0, MAX_MANIFEST_EDGES);
    }
    edgesByReadyNote.set(note.id, list);
  }

  // Belgeler edge planıyla yeniden üretilir: frontmatter'daki edges artık
  // eşlenmiş hedef kimlikleri taşır.
  const documents: AgzStageDocument[] = [];
  const notes: AgzManifestNote[] = [];
  for (const entry of pending) {
    if (!readyIds.has(entry.note.id) || !entry.mapping || !entry.target) {
      notes.push({
        sourceProjectId: entry.note.projectId,
        sourceNoteId: entry.note.id,
        targetNoteId: entry.target?.targetNoteId ?? entry.note.id,
        idDecision: entry.target?.idDecision ?? "preserved",
        idDecisionReason: entry.target?.reason ?? null,
        title: entry.note.title,
        kind: entry.note.kind,
        lifecycle: entry.note.status,
        pinned: entry.note.pinned,
        status: "quarantined",
        issues: entry.issues,
        revisions: [],
        edges: [],
        provenanceCount: 0,
      });
      continue;
    }
    const edges = edgesByReadyNote.get(entry.note.id) ?? [];
    const revisions = revisionsByNote.get(entry.note.id) ?? [];
    const provenanceByRevision = new Map<number, AgzProvenanceRecord[]>();
    for (const revision of revisions) {
      const provenance = provenanceById.get(revision.provenanceId);
      if (provenance) provenanceByRevision.set(revision.revision, [provenance]);
    }
    const builtRevisions: AgzManifestRevision[] = [];
    const noteDocuments: AgzStageDocument[] = [];
    for (const revision of revisions) {
      const document = serializeAgzDocument({
        databaseId: identity.databaseId,
        sourceProjectId: entry.note.projectId,
        sourceNoteId: entry.note.id,
        targetNoteId: entry.target.targetNoteId,
        spaceId: entry.mapping.target.memorySpaceId,
        note: entry.note,
        revision,
        provenance: provenanceByRevision.get(revision.revision) ?? [],
        edges: edges.map((edge) => ({
          relation: edge.relation,
          sourceRelation: edge.sourceRelation,
          targetSourceNoteId: edge.targetSourceNoteId,
          targetNoteId: edge.targetNoteId,
        })),
      });
      builtRevisions.push({
        sourceRevision: revision.revision,
        sourceContentHash: revision.contentHash,
        targetRevision: builtRevisions.length + 1,
        documentSha256: document.documentSha256,
        recordHash: document.recordHash,
        bytes: document.bytes,
      });
      noteDocuments.push({
        sourceProjectId: entry.note.projectId,
        sourceNoteId: entry.note.id,
        sourceRevision: revision.revision,
        relativePath: agzDocumentRelativePath(
          entry.note.id,
          revision.revision,
          document.documentSha256,
        ),
        content: document.content,
        sha256: document.documentSha256,
        bytes: document.bytes,
      });
    }
    documents.push(...noteDocuments);
    notes.push({
      sourceProjectId: entry.note.projectId,
      sourceNoteId: entry.note.id,
      targetNoteId: entry.target.targetNoteId,
      idDecision: entry.target.idDecision,
      idDecisionReason: entry.target.reason,
      title: entry.note.title,
      kind: entry.note.kind,
      lifecycle: entry.note.status,
      pinned: entry.note.pinned,
      status: "ready",
      issues: entry.issues,
      revisions: builtRevisions,
      edges,
      provenanceCount: entry.provenance.length,
    });
  }

  const readyNotes = notes.filter((note) => note.status === "ready");
  const quarantinedNotes = notes.filter(
    (note) => note.status === "quarantined",
  );
  const counts: AgzManifestCounts = {
    projects: tables.projects.length,
    notes: notes.length,
    readyNotes: readyNotes.length,
    quarantinedNotes: quarantinedNotes.length,
    revisions: readyNotes.reduce(
      (total, note) => total + note.revisions.length,
      0,
    ),
    edges: readyNotes.reduce((total, note) => total + note.edges.length, 0),
    droppedEdges: droppedEdges.length,
    provenance: readyNotes.reduce(
      (total, note) => total + note.provenanceCount,
      0,
    ),
    pinned: readyNotes.filter((note) => note.pinned).length,
  };
  const issues = [...topLevelIssues, ...droppedEdges];
  for (const note of pending)
    for (const item of note.issues)
      if (item.severity === "blocking" && !issues.includes(item))
        issues.push(item);
  const blockingIssues =
    issues.filter((item) => item.severity === "blocking").length +
    quarantinedNotes.length;
  const warningIssues = issues.filter(
    (item) => item.severity === "warning",
  ).length;
  const blocked =
    topLevelIssues.some((item) => item.severity === "blocking") ||
    readyNotes.length === 0;
  const decision: AgzImportManifest["decision"] = {
    status: blocked
      ? "blocked"
      : quarantinedNotes.length > 0 ||
          droppedEdges.length > 0 ||
          warningIssues > 0
        ? "partial"
        : "ready",
    blockingIssues,
    warningIssues,
  };

  const manifest: AgzImportManifest = {
    manifestVersion: AGZ_MANIFEST_VERSION,
    kind: "agz-memory-import-manifest",
    createdAt: now(),
    generator: {
      product: "agz-project-management-mcp",
      module: "m07-agz-import",
    },
    source: identity,
    mappings: [...input.mappings].sort((left, right) =>
      left.sourceProjectId < right.sourceProjectId ? -1 : 1,
    ),
    notes,
    counts,
    exclusions: report.exclusions,
    issues,
    decision,
  };

  return { manifest, documents };
}
