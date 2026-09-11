/**
 * #40 (M07): AGZ not/revision kayıtlarının taşınabilir M01 Markdown
 * sözleşmesine dönüşümü.
 *
 * Eski ve yeni hash sistemleri asla karıştırılmaz: AGZ `hash-tuple/2`
 * değeri `sources[].hash` ve `agz_content_hash` alanında kaynak izi olarak
 * yaşar; hedefin kendi hash'ini M01 sözleşmesi hesaplar. Tarih/provenance
 * uydurulmaz; kaynakta olmayan alan boş kalır.
 */

import { createHash } from "node:crypto";
import {
  memoryRecordHash,
  parseMemoryDocument,
  serializeMemoryDocument,
  type MemoryKind,
  type MemoryLifecycle,
  type MemoryRecord,
  type MemoryRelation,
  type MemorySource,
  type MemoryVerification,
} from "../../domain/memory.js";
import type {
  AgzKind,
  AgzNoteRecord,
  AgzNoteStatus,
  AgzPredicate,
  AgzProvenanceRecord,
  AgzRevisionRecord,
} from "./inventory.js";

export interface AgzDocumentEdge {
  relation: MemoryRelation;
  sourceRelation: AgzPredicate;
  targetSourceNoteId: string;
  targetNoteId: string;
}

export interface BuildAgzDocumentInput {
  databaseId: string;
  sourceProjectId: string;
  sourceNoteId: string;
  targetNoteId: string;
  spaceId: string;
  note: AgzNoteRecord;
  revision: AgzRevisionRecord;
  /** Bu revision'a bağlı AGZ provenance kayıtları (uydurma yok). */
  provenance: readonly AgzProvenanceRecord[];
  edges: readonly AgzDocumentEdge[];
}

export interface AgzBuiltDocument {
  content: string;
  documentSha256: string;
  recordHash: string;
  bytes: number;
}

const KIND_MAP: Readonly<Record<AgzKind, MemoryKind>> = {
  decision: "decision",
  fact: "fact",
  procedure: "procedure",
  context: "context",
  research: "research",
  preference: "preference",
  task: "task",
};

const LIFECYCLE_MAP: Readonly<Record<AgzNoteStatus, MemoryLifecycle>> = {
  active: "active",
  superseded: "superseded",
  archived: "archived",
};

const PROVENANCE_KIND_MAP: Readonly<Record<string, string>> = {
  "mcp-manual": "manual",
  "opencode-capture": "capture",
  migration: "migration",
  "legacy-import": "legacy-import",
  admin: "admin",
};

export function mapAgzKind(kind: string): MemoryKind {
  const mapped = KIND_MAP[kind as AgzKind];
  if (!mapped) throw new Error(`bilinmeyen AGZ not türü: ${kind}`);
  return mapped;
}

export function mapAgzLifecycle(status: string): MemoryLifecycle {
  const mapped = LIFECYCLE_MAP[status as AgzNoteStatus];
  if (!mapped) throw new Error(`bilinmeyen AGZ yaşam döngüsü: ${status}`);
  return mapped;
}

/**
 * Kaynak türü doğrulanmış dış olgu değildir: otomatik yakalama `proposed`,
 * diğer kullanıcı kaynaklı kayıtlar `declared` sayılır. `verified` yalnız
 * açık doğrulama ile verilir ve geçiş bunu üretmez.
 */
export function mapAgzVerification(
  provenance: readonly AgzProvenanceRecord[],
): MemoryVerification {
  return provenance.some((entry) => entry.sourceType === "opencode-capture")
    ? "proposed"
    : "declared";
}

export function mapAgzProvenanceKind(sourceType: string): string {
  return PROVENANCE_KIND_MAP[sourceType] ?? "agz";
}

export function mapAgzProvenanceSource(
  entry: AgzProvenanceRecord,
  sourceRevision: number,
  sourceContentHash: string,
): MemorySource {
  return {
    id: entry.captureEventId ?? entry.id,
    kind: mapAgzProvenanceKind(entry.sourceType),
    revision: String(sourceRevision),
    hash: sourceContentHash,
  };
}

export function buildAgzMemoryRecord(
  input: BuildAgzDocumentInput,
): MemoryRecord {
  const provenance = input.provenance;
  const sources: MemorySource[] = [];
  const seen = new Set<string>();
  for (const entry of provenance) {
    const source = mapAgzProvenanceSource(
      entry,
      input.revision.revision,
      input.revision.contentHash,
    );
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    sources.push(source);
  }

  const unknown: Record<string, unknown> = {
    agz_database_id: input.databaseId,
    agz_project_id: input.sourceProjectId,
    agz_note_id: input.sourceNoteId,
    agz_revision: input.revision.revision,
    agz_content_hash: input.revision.contentHash,
    agz_note_created_at: input.note.createdAt,
    agz_note_updated_at: input.note.updatedAt,
    agz_revision_created_at: input.revision.createdAt,
    agz_size_class: input.note.sizeClass,
    agz_subject_key: input.note.subjectKey,
    agz_supersedes_id: input.note.supersedesId,
    agz_provenance: provenance.map((entry) => ({
      id: entry.id,
      source_type: entry.sourceType,
      capture_event_id: entry.captureEventId,
      source_session_id: entry.sourceSessionId,
      source_message_id: entry.sourceMessageId,
      source_ordinal: entry.sourceOrdinal,
      source_tool_call_id: entry.sourceToolCallId,
      redaction_version: entry.redactionVersion,
      extractor_version: entry.extractorVersion,
      confidence: entry.confidence,
      created_at: entry.createdAt,
    })),
  };

  return {
    formatVersion: 1,
    noteId: input.targetNoteId,
    spaceId: input.spaceId,
    kind: mapAgzKind(input.revision.kind),
    title: input.note.title,
    summary: input.note.summary,
    lifecycle: mapAgzLifecycle(input.revision.status),
    pinned: input.revision.pinned,
    taskStatus: null,
    verification: mapAgzVerification(provenance),
    stale: null,
    sources,
    edges: input.edges.map((edge) => ({
      relation: edge.relation,
      target: edge.targetNoteId,
    })),
    createdAt: input.note.createdAt,
    observedAt: null,
    validFrom: null,
    validUntil: null,
    baseRevision: null,
    revision: null,
    unknown,
    body: input.revision.content,
  };
}

/**
 * Kanonik Markdown üretir ve sözleşmeye geri okuyarak doğrular. Doğrulama
 * başarısızsa (ör. başlık/özet sınırı) belge üretilmez; çağıran kaydı
 * karantinaya alır.
 */
export function serializeAgzDocument(
  input: BuildAgzDocumentInput,
): AgzBuiltDocument {
  const record = buildAgzMemoryRecord(input);
  const content = serializeMemoryDocument(record);
  const parsed = parseMemoryDocument(content);
  if (parsed.status !== "ok")
    throw new Error(
      `AGZ belgesi M01 sözleşmesine dönüştürülemedi: ${parsed.status}`,
    );
  if (
    parsed.record.noteId !== input.targetNoteId ||
    parsed.record.spaceId !== input.spaceId
  )
    throw new Error("AGZ belgesi kimlik doğrulaması başarısız");
  const documentSha256 = createHash("sha256")
    .update(content, "utf8")
    .digest("hex");
  return {
    content,
    documentSha256,
    recordHash: memoryRecordHash(record),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}
