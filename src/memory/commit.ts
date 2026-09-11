import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB, MemoryEvent } from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
import {
  memoryRecordHash,
  parseMemoryDocument,
  serializeMemoryDocument,
  type MemoryKind,
  type MemoryRecord,
} from "../domain/memory.js";
import { sanitizeUntrustedText } from "../telemetry/sanitize.js";
import {
  isUniqueViolation,
  MemoryService,
  type MemoryRunScope,
} from "./service.js";
import { SpaceSerialQueue, VaultWriter } from "./writer.js";
import {
  atomicWriteFile,
  byteSize,
  listRevisionFiles,
  publishRevisionFile,
  readTextIfExists,
  readWorkingCopy,
  removeFileIfExists,
  sha256Hex,
  writeQuarantine,
} from "./files.js";
import {
  noteWorkingPath,
  relativeVaultPath,
  resolveVaultRelative,
  tempDir,
} from "./paths.js";

/**
 * Issue #35 (M02): the revision commit state machine.
 *
 * Order: validate -> temp+fsync -> immutable revision publication -> DB
 * (revision row + head CAS + event committed + durable receipt) -> derived
 * index marker. Filesystem and SQL are never assumed to be one atomic
 * transaction; every interruption point has a replay rule:
 *
 *  (a) before ACK: the event stays `pending`; the handler retries.
 *  (b) after file publication, before DB: the orphan revision file is
 *      adopted when the event+hash match on retry; unrelated orphans are
 *      quarantined (metadata only) and removed.
 *  (c) after DB, before the index marker: the committed receipt is durable;
 *      replay completes the marker without a second revision.
 *
 * CAS losers only ever remove their own unreferenced candidate file; the
 * winner's file is protected by the hash embedded in its path.
 */

export const MEMORY_CONTENT_MAX_BYTES = 48 * 1024;
/** Source kinds whose text is user-authored and never silently rewritten. */
const TRUSTED_SOURCE_KINDS = new Set(["manual", "editor", "ui"]);

export interface MemoryCommitHooks {
  /** Test-only crash injection: after file publication, before DB. */
  afterPublish?: () => void | Promise<void>;
  /** Test-only crash injection: after DB commit, before the index marker. */
  afterCommitBeforeIndex?: () => void | Promise<void>;
}

export interface MemoryCommitInput {
  identity: Identity;
  /** Persisted run scope; when present the run scope must match the target. */
  run?: MemoryRunScope | null;
  spaceId: string;
  eventId: string;
  sourceKind?: string;
  content: string;
  noteId?: string | null;
  baseRevision?: number | null;
  kind?: MemoryKind;
}

export interface MemoryCommitReceipt {
  status: "committed" | "duplicate";
  noteId: string;
  revision: number;
  /** Revision-independent canonical record hash (M01 format contract). */
  recordHash: string;
  /** Byte-exact hash of the immutable revision file. */
  fileHash: string;
  /** Vault-relative immutable file path. */
  filePath: string;
  byteSize: number;
  redacted: boolean;
  indexed: boolean;
}

export interface MemoryCommitDeps {
  db: Kysely<DB>;
  vaultRoot: string;
  writer?: VaultWriter;
  service?: MemoryService;
  hooks?: MemoryCommitHooks;
}

export class MemoryCommitService {
  readonly writer: VaultWriter;
  private readonly service: MemoryService;
  private readonly hooks?: MemoryCommitHooks;
  private readonly spaces = new SpaceSerialQueue();

  constructor(readonly deps: MemoryCommitDeps) {
    this.writer = deps.writer ?? new VaultWriter(deps.vaultRoot);
    this.service = deps.service ?? new MemoryService(deps.db);
    this.hooks = deps.hooks;
  }

  private get db(): Kysely<DB> {
    return this.deps.db;
  }

  async commit(input: MemoryCommitInput): Promise<MemoryCommitReceipt> {
    const size = byteSize(input.content);
    if (size > MEMORY_CONTENT_MAX_BYTES)
      throw new ForgeError(
        "memory_content_limit",
        "İçerik boyut sınırını aşıyor.",
        422,
        undefined,
        { size, limit: MEMORY_CONTENT_MAX_BYTES },
      );
    // ACL + run-scope gate first; a foreign tenant stays an indistinguishable
    // 404 through MemoryService.
    if (input.run)
      await this.service.authorizeRunSpace(input.run, input.spaceId, "write");
    else
      await this.service.authorizeSpace(input.identity, input.spaceId, "write");

    const clientHash = sha256Hex(input.content);
    const event = await this.loadEvent(input);
    if (!event)
      throw new ForgeError("memory_event_unavailable", "Olay bulunamadı.", 404);
    if (event.content_hash !== clientHash)
      throw new ForgeError(
        "memory_content_mismatch",
        "Teslim edilen içerik kabul edilen hash ile eşleşmiyor.",
        409,
      );

    // Redaction policy: automatic capture is redacted before it reaches disk;
    // a user-authored document that would change is rejected for explicit
    // review instead of being silently rewritten.
    const trusted = TRUSTED_SOURCE_KINDS.has(input.sourceKind ?? "manual");
    const sanitized = sanitizeUntrustedText(
      input.content,
      MEMORY_CONTENT_MAX_BYTES,
    );
    let storedContent = input.content;
    let redacted = false;
    if (sanitized !== input.content) {
      if (trusted)
        throw new ForgeError(
          "memory_unsafe_content",
          "İçerik güvenli olmayan veri taşıyor; açık inceleme gerekir.",
          422,
        );
      storedContent = sanitized;
      redacted = true;
    }

    const { record, noteId } = this.buildRecord({
      ...input,
      content: storedContent,
    });
    const lease = await this.writer.acquire();
    try {
      return await this.spaces.run(input.spaceId, () =>
        this.commitLocked(input, event, noteId, record, redacted),
      );
    } finally {
      await lease.release();
    }
  }

  private async loadEvent(
    input: MemoryCommitInput,
  ): Promise<MemoryEvent | undefined> {
    return this.db
      .selectFrom("memory_events")
      .selectAll()
      .where("tenant_id", "=", input.identity.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("id", "=", input.eventId)
      .executeTakeFirst();
  }

  private buildRecord(input: MemoryCommitInput): {
    record: MemoryRecord;
    noteId: string;
  } {
    const parsed = parseMemoryDocument(input.content);
    if (parsed.status === "unsupported_format")
      throw new ForgeError(
        "memory_format_unsupported",
        "Desteklenmeyen format sürümü; içerik değiştirilmedi.",
        422,
        undefined,
        { formatVersion: parsed.formatVersion },
      );
    if (parsed.status === "invalid") {
      if (input.content.trimStart().startsWith("---"))
        throw new ForgeError(
          "invalid_memory_document",
          "Frontmatter geçersiz; içerik değiştirilmedi.",
          422,
          undefined,
          { issues: parsed.issues.slice(0, 10) },
        );
      const noteId = input.noteId?.trim() || randomUUID();
      return {
        noteId,
        record: {
          formatVersion: 1,
          noteId,
          spaceId: input.spaceId,
          kind: input.kind ?? "note",
          title: deriveTitle(input.content),
          summary: null,
          lifecycle: "active",
          pinned: false,
          taskStatus: null,
          verification: "declared",
          stale: null,
          sources: [],
          edges: [],
          createdAt: Date.now(),
          observedAt: null,
          validFrom: null,
          validUntil: null,
          baseRevision: input.baseRevision ?? null,
          revision: null,
          unknown: {},
          body: input.content.endsWith("\n")
            ? input.content
            : `${input.content}\n`,
        },
      };
    }
    const record = parsed.record;
    if (record.spaceId !== input.spaceId)
      throw new ForgeError(
        "memory_space_mismatch",
        "Belge hedef alanla eşleşmiyor.",
        422,
      );
    if (input.noteId && input.noteId !== record.noteId)
      throw new ForgeError(
        "memory_note_id_mismatch",
        "Belge note_id hedefle eşleşmiyor.",
        422,
      );
    return { record, noteId: record.noteId };
  }

  private async commitLocked(
    input: MemoryCommitInput,
    event: MemoryEvent,
    noteId: string,
    record: MemoryRecord,
    redacted: boolean,
  ): Promise<MemoryCommitReceipt> {
    // Re-read the event under the writer lock: another process may have
    // committed it between read and lock acquisition.
    const current = await this.loadEvent(input);
    if (!current)
      throw new ForgeError("memory_event_unavailable", "Olay bulunamadı.", 404);
    if (current.state === "committed") return this.completeReplay(current);
    if (current.state === "rejected")
      throw new ForgeError("memory_event_rejected", "Olay reddedilmiş.", 409);

    const note = await this.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("tenant_id", "=", input.identity.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("id", "=", noteId)
      .executeTakeFirst();
    if (note?.deleted_at)
      throw new ForgeError(
        "memory_note_deleted",
        "Not arşivlenmiş/silinmiş; önce açık restore gerekir.",
        409,
      );
    let expected: number | null;
    if (note) {
      if (input.baseRevision === undefined || input.baseRevision === null)
        throw new ForgeError(
          "memory_revision_required",
          "Güncelleme için base_revision zorunludur.",
          422,
          undefined,
          { current_revision: note.current_revision },
        );
      expected = note.current_revision;
      if (expected === null || input.baseRevision !== expected)
        throw new ForgeError(
          "memory_revision_conflict",
          "Not başka bir değişiklikle ilerlemiş; güncel sürümü okuyun.",
          409,
          undefined,
          {
            current_revision: note.current_revision,
            base_revision: input.baseRevision,
          },
        );
    } else {
      if (input.baseRevision !== undefined && input.baseRevision !== null)
        throw new ForgeError(
          "memory_revision_conflict",
          "Not henüz yok; base_revision gönderilmemeli.",
          409,
          undefined,
          { base_revision: input.baseRevision },
        );
      expected = null;
    }
    const newRevision = (expected ?? 0) + 1;

    const canonical: MemoryRecord = {
      ...record,
      baseRevision: expected,
      revision: newRevision,
    };
    const canonicalParsed = parseMemoryDocument(
      serializeMemoryDocument(canonical),
    );
    const finalRecord: MemoryRecord =
      canonicalParsed.status === "ok" ? canonicalParsed.record : canonical;
    const fileContent = serializeMemoryDocument(finalRecord);
    const recordHash = memoryRecordHash(finalRecord);
    const fileHash = sha256Hex(fileContent);
    const size = byteSize(fileContent);

    const published = await publishRevisionFile(
      this.deps.vaultRoot,
      input.spaceId,
      noteId,
      newRevision,
      fileHash,
      fileContent,
    );
    await this.hooks?.afterPublish?.();

    // Managed working copy: never clobber a newer external edit. The expected
    // hash is the previous revision's byte hash.
    const workingPath = noteWorkingPath(
      this.deps.vaultRoot,
      input.spaceId,
      noteId,
    );
    const existingWorking = await readWorkingCopy(
      this.deps.vaultRoot,
      input.spaceId,
      noteId,
    );
    let workingConflict: { previous: string | null; observed: string } | null =
      null;
    let expectedWorkingHash: string | null = null;
    if (note?.current_revision != null) {
      const previousRevision = await this.db
        .selectFrom("memory_note_revisions")
        .select(["content_hash"])
        .where("tenant_id", "=", input.identity.tenantId)
        .where("space_id", "=", input.spaceId)
        .where("note_id", "=", noteId)
        .where("revision", "=", note.current_revision)
        .executeTakeFirst();
      expectedWorkingHash = previousRevision?.content_hash ?? null;
    }
    if (!existingWorking || existingWorking.hash === expectedWorkingHash) {
      await atomicWriteFile(workingPath, fileContent, {
        tempDir: tempDir(this.deps.vaultRoot),
      });
    } else {
      workingConflict = {
        previous: expectedWorkingHash,
        observed: existingWorking.hash,
      };
    }

    const now = Date.now();
    const receipt: MemoryCommitReceipt = {
      status: "committed",
      noteId,
      revision: newRevision,
      recordHash,
      fileHash,
      filePath: published.relativePath,
      byteSize: size,
      redacted,
      indexed: false,
    };
    try {
      await this.db.transaction().execute(async (tx) => {
        const fresh = await tx
          .selectFrom("memory_events")
          .selectAll()
          .where("tenant_id", "=", input.identity.tenantId)
          .where("space_id", "=", input.spaceId)
          .where("id", "=", input.eventId)
          .executeTakeFirst();
        if (!fresh || fresh.state !== "pending")
          throw new ForgeError(
            fresh?.state === "committed"
              ? "memory_event_conflict"
              : "memory_event_unavailable",
            "Olay durumu commit sırasında değişti.",
            409,
          );
        const freshNote = await tx
          .selectFrom("memory_notes")
          .select(["current_revision", "deleted_at"])
          .where("tenant_id", "=", input.identity.tenantId)
          .where("space_id", "=", input.spaceId)
          .where("id", "=", noteId)
          .executeTakeFirst();
        if (freshNote?.deleted_at)
          throw new ForgeError(
            "memory_note_deleted",
            "Not arşivlenmiş/silinmiş; önce açık restore gerekir.",
            409,
          );
        if ((freshNote?.current_revision ?? null) !== expected)
          throw new ForgeError(
            "memory_revision_conflict",
            "Not başka bir değişiklikle ilerlemiş; güncel sürümü okuyun.",
            409,
          );
        if (freshNote) {
          const updated = await tx
            .updateTable("memory_notes")
            .set({
              current_revision: newRevision,
              title: finalRecord.title,
              summary: finalRecord.summary,
              format_version: finalRecord.formatVersion,
              updated_at: now,
            })
            .where("tenant_id", "=", input.identity.tenantId)
            .where("space_id", "=", input.spaceId)
            .where("id", "=", noteId)
            .where("current_revision", "=", expected)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows) !== 1)
            throw new ForgeError(
              "memory_revision_conflict",
              "Not başka bir değişiklikle ilerlemiş; güncel sürümü okuyun.",
              409,
            );
        } else {
          await tx
            .insertInto("memory_notes")
            .values({
              tenant_id: input.identity.tenantId,
              space_id: input.spaceId,
              id: noteId,
              lifecycle: finalRecord.lifecycle,
              pinned: finalRecord.pinned ? 1 : 0,
              task_status: finalRecord.taskStatus,
              current_revision: newRevision,
              format_version: finalRecord.formatVersion,
              title: finalRecord.title,
              summary: finalRecord.summary,
              created_at: now,
              updated_at: now,
              superseded_by: null,
              source_id: null,
              source_path: null,
              source_hash: null,
              source_state: "present",
              deleted_at: null,
            })
            .execute();
        }
        // The revision row references the note head, so the note exists first.
        await tx
          .insertInto("memory_note_revisions")
          .values({
            tenant_id: input.identity.tenantId,
            space_id: input.spaceId,
            note_id: noteId,
            revision: newRevision,
            format_version: finalRecord.formatVersion,
            kind: finalRecord.kind,
            title: finalRecord.title,
            summary: finalRecord.summary,
            body_md: finalRecord.body,
            metadata_json: JSON.stringify({
              record_hash: recordHash,
              client_hash: event.content_hash,
              redacted,
            }),
            sources_json: JSON.stringify(finalRecord.sources),
            base_revision: expected,
            created_by: input.identity.userId,
            created_at: now,
            file_path: published.relativePath,
            content_hash: fileHash,
            byte_size: size,
          })
          .execute();
        const committedReceipt: MemoryCommitReceipt = {
          ...receipt,
          indexed: false,
        };
        await tx
          .updateTable("memory_events")
          .set({
            state: "committed",
            committed_revision: newRevision,
            receipt_json: JSON.stringify(committedReceipt),
            error_code: null,
            attempts: sql`attempts + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", input.identity.tenantId)
          .where("space_id", "=", input.spaceId)
          .where("id", "=", input.eventId)
          .where("state", "=", "pending")
          .execute();
      });
    } catch (error) {
      if (error instanceof ForgeError) {
        if (error.code === "memory_revision_conflict")
          await this.removeUnreferencedCandidate(
            input,
            noteId,
            published.relativePath,
            published.path,
          );
        throw error;
      }
      if (isUniqueViolation(error)) {
        // A competing writer committed the same revision first.
        await this.removeUnreferencedCandidate(
          input,
          noteId,
          published.relativePath,
          published.path,
        );
        throw new ForgeError(
          "memory_revision_conflict",
          "Not başka bir değişiklikle ilerlemiş; güncel sürümü okuyun.",
          409,
        );
      }
      throw error;
    }

    if (workingConflict) {
      const candidateId = randomUUID();
      await this.db
        .insertInto("memory_change_candidates")
        .values({
          tenant_id: input.identity.tenantId,
          id: candidateId,
          source_id: null,
          path: workingPath,
          note_id: noteId,
          previous_hash: workingConflict.previous,
          observed_hash: workingConflict.observed,
          base_revision: expected,
          state: "conflict",
          reason: "working_copy_changed",
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    await this.hooks?.afterCommitBeforeIndex?.();
    let indexed = true;
    try {
      await this.markIndexed(input, now);
    } catch {
      indexed = false;
    }
    await this.cleanupOrphanRevisions(input, noteId).catch(() => undefined);
    return { ...receipt, status: "committed", indexed };
  }

  private async markIndexed(input: MemoryCommitInput, now: number) {
    await this.db
      .updateTable("memory_events")
      .set({ indexed_at: now, updated_at: now })
      .where("tenant_id", "=", input.identity.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("id", "=", input.eventId)
      .where("indexed_at", "is", null)
      .execute();
  }

  private async completeReplay(
    event: MemoryEvent,
  ): Promise<MemoryCommitReceipt> {
    const stored = event.receipt_json
      ? (JSON.parse(event.receipt_json) as MemoryCommitReceipt)
      : null;
    const receipt = stored ?? (await this.reconstructReceipt(event));
    // Never claim success without the immutable file.
    if (!receipt.filePath)
      throw new ForgeError(
        "memory_revision_file_missing",
        "Kabul edilmiş revision dosyası bulunamadı.",
        409,
      );
    const absolute = resolveVaultRelative(
      this.deps.vaultRoot,
      receipt.filePath,
    );
    const content = await readTextIfExists(absolute);
    if (content === null || sha256Hex(content) !== receipt.fileHash)
      throw new ForgeError(
        "memory_revision_file_missing",
        "Kabul edilmiş revision dosyası bulunamadı veya bozulmuş.",
        409,
      );
    let indexed = event.indexed_at !== null;
    if (!indexed) {
      const now = Date.now();
      try {
        await this.db
          .updateTable("memory_events")
          .set({ indexed_at: now, updated_at: now })
          .where("tenant_id", "=", event.tenant_id)
          .where("space_id", "=", event.space_id)
          .where("id", "=", event.id)
          .where("indexed_at", "is", null)
          .execute();
        indexed = true;
      } catch {
        indexed = false;
      }
    }
    return { ...receipt, status: "duplicate", indexed };
  }

  private async reconstructReceipt(
    event: MemoryEvent,
  ): Promise<MemoryCommitReceipt> {
    const revision = event.committed_revision;
    const row = revision
      ? await this.db
          .selectFrom("memory_note_revisions")
          .selectAll()
          .where("tenant_id", "=", event.tenant_id)
          .where("space_id", "=", event.space_id)
          .where("revision", "=", revision)
          .executeTakeFirst()
      : undefined;
    if (!row)
      throw new ForgeError(
        "memory_revision_file_missing",
        "Kabul edilmiş revision kaydı bulunamadı.",
        409,
      );
    const metadata = JSON.parse(row.metadata_json) as {
      record_hash?: string;
    };
    return {
      status: "committed",
      noteId: row.note_id,
      revision: row.revision,
      recordHash: metadata.record_hash ?? row.content_hash ?? "",
      fileHash: row.content_hash ?? "",
      filePath: row.file_path ?? "",
      byteSize: row.byte_size ?? 0,
      redacted: false,
      indexed: event.indexed_at !== null,
    };
  }

  private async removeUnreferencedCandidate(
    input: MemoryCommitInput,
    noteId: string,
    relativePath: string,
    absolutePath: string,
  ): Promise<void> {
    const referenced = await this.db
      .selectFrom("memory_note_revisions")
      .select(["revision"])
      .where("tenant_id", "=", input.identity.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("note_id", "=", noteId)
      .where("file_path", "=", relativePath)
      .executeTakeFirst();
    if (!referenced) await removeFileIfExists(absolutePath);
  }

  /**
   * Unreferenced revision files are never blindly deleted: their hash/path is
   * recorded in the metadata-only quarantine, then the orphan is removed.
   * Bounded per commit; the winner's referenced file is never touched.
   */
  private async cleanupOrphanRevisions(
    input: MemoryCommitInput,
    noteId: string,
  ): Promise<void> {
    const files = await listRevisionFiles(
      this.deps.vaultRoot,
      input.spaceId,
      noteId,
    );
    if (files.length === 0) return;
    const rows = await this.db
      .selectFrom("memory_note_revisions")
      .select(["file_path"])
      .where("tenant_id", "=", input.identity.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("note_id", "=", noteId)
      .execute();
    const referenced = new Set(
      rows.map((row) => row.file_path).filter((path): path is string => !!path),
    );
    let cleaned = 0;
    for (const absolute of files) {
      if (cleaned >= 50) break;
      const relative = relativeVaultPath(this.deps.vaultRoot, absolute);
      if (!relative || referenced.has(relative)) continue;
      const content = await readTextIfExists(absolute);
      await writeQuarantine(this.deps.vaultRoot, {
        reason: "orphan_revision",
        hash: content !== null ? sha256Hex(content) : null,
        path: relative,
        summary: "Referanssız revision dosyası karantinaya alındı.",
      });
      await removeFileIfExists(absolute);
      cleaned += 1;
    }
  }

  /** Read-only receipt view for the HTTP layer; ACL via the space. */
  async receipt(identity: Identity, spaceId: string, sourceEventKey: string) {
    await this.service.authorizeSpace(identity, spaceId, "read");
    const event = await this.db
      .selectFrom("memory_events")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", spaceId)
      .where("source_event_key", "=", sourceEventKey)
      .executeTakeFirst();
    if (!event)
      throw new ForgeError("memory_event_unavailable", "Olay bulunamadı.", 404);
    return {
      event_id: event.id,
      state: event.state,
      indexed: event.indexed_at !== null,
      committed_revision: event.committed_revision,
      error_code: event.error_code,
      receipt: event.receipt_json
        ? (JSON.parse(event.receipt_json) as MemoryCommitReceipt)
        : null,
    };
  }
}

function deriveTitle(content: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    const title = (heading ? heading[1]! : trimmed).trim();
    return title.slice(0, 200) || "Not";
  }
  return "Not";
}
