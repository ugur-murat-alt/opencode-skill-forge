import type { Kysely } from "kysely";
import type {
  DB,
  MemoryIndexHead,
  MemoryIndexTerm,
} from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
import { parseMemoryDocument } from "../domain/memory.js";
import { readTextIfExists } from "./files.js";
import { resolveVaultRelative } from "./paths.js";
import { MemoryService } from "./service.js";
import {
  MEMORY_BODY_TERM_LIMIT,
  MEMORY_TITLE_TERM_LIMIT,
  termFrequencies,
} from "./text.js";

/**
 * Issue #36 (M03): derived lexical/graph index.
 *
 * Every row is bound to an accepted `note_id`/`revision`/`content_hash` and is
 * rebuilt from `memory_note_revisions` (or the revision file when semantic
 * metadata is missing). Rebuild replaces only `memory_index_*` rows: notes,
 * ACL, events and queue history are untouched. Revision terms are indexed in
 * per-note batches so a 10k-note corpus stays bounded.
 */

export interface IndexedRecord {
  recordHash: string;
  kind: string;
  title: string;
  summary: string | null;
  lifecycle: string;
  pinned: boolean;
  taskStatus: string | null;
  verification: string;
  sources: readonly unknown[];
  edges: { relation: string; target: string }[];
  body: string;
  validFrom: number | null;
  validUntil: number | null;
}

interface RevisionRow {
  tenant_id: string;
  space_id: string;
  note_id: string;
  revision: number;
  content_hash: string | null;
  body_md: string;
  metadata_json: string;
  sources_json: string;
}

/**
 * Rebuild an indexable record from the accepted revision row. New commits
 * embed the semantic record in `metadata_json`; older rows fall back to the
 * immutable revision file, and finally to `null` (skipped and counted) rather
 * than fabricating metadata.
 */
export async function indexedRecordFromRevision(
  row: RevisionRow,
): Promise<IndexedRecord | null> {
  let metadata: {
    record_hash?: string;
    record?: {
      kind?: string;
      title?: string;
      summary?: string | null;
      lifecycle?: string;
      pinned?: boolean;
      task_status?: string | null;
      verification?: string;
      sources?: unknown[];
      edges?: { relation: string; target: string }[];
      valid_from?: number | null;
      valid_until?: number | null;
    };
  } = {};
  try {
    metadata = JSON.parse(row.metadata_json) as typeof metadata;
  } catch {
    metadata = {};
  }
  if (metadata.record) {
    return {
      recordHash: metadata.record_hash ?? "",
      kind: metadata.record.kind ?? "note",
      title: metadata.record.title ?? "",
      summary: metadata.record.summary ?? null,
      lifecycle: metadata.record.lifecycle ?? "active",
      pinned: Boolean(metadata.record.pinned),
      taskStatus: metadata.record.task_status ?? null,
      verification: metadata.record.verification ?? "declared",
      sources: metadata.record.sources ?? [],
      edges: metadata.record.edges ?? [],
      body: row.body_md,
      validFrom: metadata.record.valid_from ?? null,
      validUntil: metadata.record.valid_until ?? null,
    };
  }
  return null;
}

/** File-based fallback used when `metadata_json` predates M03. */
export async function indexedRecordFromFile(
  row: RevisionRow & { file_path?: string | null },
  vaultRoot: string,
): Promise<IndexedRecord | null> {
  if (!row.file_path) return null;
  const text = await readTextIfExists(
    resolveVaultRelative(vaultRoot, row.file_path),
  );
  if (text === null) return null;
  const parsed = parseMemoryDocument(text);
  if (parsed.status !== "ok") return null;
  return {
    recordHash: "",
    kind: parsed.record.kind,
    title: parsed.record.title,
    summary: parsed.record.summary,
    lifecycle: parsed.record.lifecycle,
    pinned: parsed.record.pinned,
    taskStatus: parsed.record.taskStatus,
    verification: parsed.record.verification,
    sources: parsed.record.sources,
    edges: parsed.record.edges.map((edge) => ({
      relation: edge.relation,
      target: edge.target,
    })),
    body: parsed.record.body,
    validFrom: parsed.record.validFrom,
    validUntil: parsed.record.validUntil,
  };
}

export interface RebuildReport {
  indexed: number;
  skipped: number;
  next: string | null;
}

export class MemoryIndexService {
  constructor(
    readonly db: Kysely<DB>,
    readonly vaultRoot?: string,
    readonly service: MemoryService = new MemoryService(db),
  ) {}

  /** Index one accepted revision; replaces this note's derived rows. */
  async indexRevision(input: {
    tenantId: string;
    spaceId: string;
    noteId: string;
    revision: number;
    contentHash: string;
    record: IndexedRecord;
  }): Promise<void> {
    const now = Date.now();
    const termRows: MemoryIndexTerm[] = [];
    const pushTerms = (
      field: "title" | "body" | "kind",
      value: string,
      limit: number,
    ) => {
      for (const [term, frequency] of termFrequencies(value, limit))
        termRows.push({
          tenant_id: input.tenantId,
          space_id: input.spaceId,
          note_id: input.noteId,
          revision: input.revision,
          content_hash: input.contentHash,
          term,
          field,
          frequency,
        });
    };
    pushTerms("title", input.record.title, MEMORY_TITLE_TERM_LIMIT);
    pushTerms("kind", input.record.kind, 8);
    pushTerms("body", input.record.body, MEMORY_BODY_TERM_LIMIT);
    const targets = [
      ...new Set(input.record.edges.map((edge) => edge.target)),
    ].slice(0, 200);
    const targetRevisions = targets.length
      ? await this.db
          .selectFrom("memory_notes")
          .select(["id", "current_revision"])
          .where("tenant_id", "=", input.tenantId)
          .where("space_id", "=", input.spaceId)
          .where("id", "in", targets)
          .execute()
      : [];
    const targetMap = new Map(
      targetRevisions.map((row) => [row.id, row.current_revision]),
    );
    const edgeRows = input.record.edges.slice(0, 200).map((edge) => ({
      tenant_id: input.tenantId,
      space_id: input.spaceId,
      source_note_id: input.noteId,
      source_revision: input.revision,
      relation: edge.relation,
      target_note_id: edge.target,
      target_revision: targetMap.get(edge.target) ?? null,
      created_at: now,
    }));
    const head: MemoryIndexHead = {
      tenant_id: input.tenantId,
      space_id: input.spaceId,
      note_id: input.noteId,
      revision: input.revision,
      content_hash: input.contentHash,
      record_hash: input.record.recordHash,
      kind: input.record.kind,
      title: input.record.title,
      summary: input.record.summary,
      lifecycle: input.record.lifecycle,
      pinned: input.record.pinned ? 1 : 0,
      task_status: input.record.taskStatus,
      verification: input.record.verification,
      sources_json: JSON.stringify(input.record.sources),
      edges_json: JSON.stringify(input.record.edges),
      valid_from: input.record.validFrom,
      valid_until: input.record.validUntil,
      indexed_at: now,
    };
    await this.db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom("memory_index_terms")
        .where("tenant_id", "=", input.tenantId)
        .where("space_id", "=", input.spaceId)
        .where("note_id", "=", input.noteId)
        .execute();
      await tx
        .deleteFrom("memory_index_edges")
        .where("tenant_id", "=", input.tenantId)
        .where("space_id", "=", input.spaceId)
        .where("source_note_id", "=", input.noteId)
        .execute();
      for (let start = 0; start < termRows.length; start += 200)
        await tx
          .insertInto("memory_index_terms")
          .values(termRows.slice(start, start + 200))
          .execute();
      for (let start = 0; start < edgeRows.length; start += 200)
        await tx
          .insertInto("memory_index_edges")
          .values(edgeRows.slice(start, start + 200))
          .onConflict((oc) => oc.doNothing())
          .execute();
      await tx
        .insertInto("memory_index_heads")
        .values(head)
        .onConflict((oc) =>
          oc.columns(["tenant_id", "space_id", "note_id"]).doUpdateSet({
            revision: head.revision,
            content_hash: head.content_hash,
            record_hash: head.record_hash,
            kind: head.kind,
            title: head.title,
            summary: head.summary,
            lifecycle: head.lifecycle,
            pinned: head.pinned,
            task_status: head.task_status,
            verification: head.verification,
            sources_json: head.sources_json,
            edges_json: head.edges_json,
            valid_from: head.valid_from,
            valid_until: head.valid_until,
            indexed_at: head.indexed_at,
          }),
        )
        .execute();
    });
  }

  /** Index one note's accepted head revision, if it exists. */
  async indexNote(
    tenantId: string,
    spaceId: string,
    noteId: string,
  ): Promise<boolean> {
    const note = await this.db
      .selectFrom("memory_notes")
      .select(["current_revision"])
      .where("tenant_id", "=", tenantId)
      .where("space_id", "=", spaceId)
      .where("id", "=", noteId)
      .executeTakeFirst();
    if (!note?.current_revision) return false;
    const row = await this.db
      .selectFrom("memory_note_revisions")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("space_id", "=", spaceId)
      .where("note_id", "=", noteId)
      .where("revision", "=", note.current_revision)
      .executeTakeFirst();
    if (!row?.content_hash) return false;
    const record =
      (await indexedRecordFromRevision(row)) ??
      (this.vaultRoot
        ? await indexedRecordFromFile(row, this.vaultRoot)
        : null);
    if (!record) return false;
    await this.indexRevision({
      tenantId,
      spaceId,
      noteId,
      revision: row.revision,
      contentHash: row.content_hash,
      record,
    });
    return true;
  }

  /** Bounded derived-index rebuild. Only `memory_index_*` rows change. */
  async rebuild(
    identity: Identity,
    input: { spaceId?: string; after?: string; batchSize?: number } = {},
  ): Promise<RebuildReport> {
    const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
    let spaceIds: string[];
    if (input.spaceId) {
      await this.service.authorizeSpace(identity, input.spaceId, "read");
      spaceIds = [input.spaceId];
    } else {
      spaceIds = (await this.service.listSpaces(identity)).items.map(
        (space) => space.id,
      );
    }
    if (spaceIds.length === 0) return { indexed: 0, skipped: 0, next: null };
    let query = this.db
      .selectFrom("memory_notes")
      .select(["tenant_id", "space_id", "id"])
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaceIds)
      .where("current_revision", "is not", null);
    if (input.after) query = query.where("id", ">", input.after);
    const notes = await query
      .orderBy("id")
      .limit(batchSize + 1)
      .execute();
    const page = notes.slice(0, batchSize);
    let indexed = 0;
    let skipped = 0;
    for (const note of page) {
      const ok = await this.indexNote(
        identity.tenantId,
        note.space_id,
        note.id,
      );
      if (ok) indexed += 1;
      else skipped += 1;
    }
    return {
      indexed,
      skipped,
      next: notes.length > batchSize ? page[page.length - 1]!.id : null,
    };
  }

  /** Repair committed events whose derived index marker is missing. */
  async indexPending(
    identity: Identity,
    input: { spaceIds?: string[]; limit?: number } = {},
  ): Promise<{ indexed: number; remaining: number }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    let spaceIds = input.spaceIds ?? [];
    if (spaceIds.length === 0)
      spaceIds = (await this.service.listSpaces(identity)).items.map(
        (space) => space.id,
      );
    if (spaceIds.length === 0) return { indexed: 0, remaining: 0 };
    const events = await this.db
      .selectFrom("memory_events")
      .select(["id", "space_id", "note_id", "committed_revision"])
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaceIds)
      .where("state", "=", "committed")
      .where("indexed_at", "is", null)
      .where("note_id", "is not", null)
      .orderBy("updated_at")
      .limit(limit)
      .execute();
    let indexed = 0;
    const now = Date.now();
    for (const event of events) {
      if (!event.note_id || event.committed_revision === null) continue;
      const ok = await this.indexNote(
        identity.tenantId,
        event.space_id,
        event.note_id,
      );
      if (!ok) continue;
      await this.db
        .updateTable("memory_events")
        .set({ indexed_at: now, updated_at: now })
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "=", event.space_id)
        .where("id", "=", event.id)
        .where("indexed_at", "is", null)
        .execute();
      indexed += 1;
    }
    const remaining = await this.db
      .selectFrom("memory_events")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaceIds)
      .where("state", "=", "committed")
      .where("indexed_at", "is", null)
      .executeTakeFirstOrThrow();
    return { indexed, remaining: Number(remaining.n) };
  }
}
