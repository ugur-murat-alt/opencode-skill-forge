import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Identity } from "../../application/identity.js";
import type {
  DB,
  MemoryCuratorChange,
  MemorySpace,
} from "../../storage/schema.js";
import {
  serializeMemoryDocument,
  type MemoryEdge,
  type MemoryKind,
  type MemoryRecord,
  type MemorySource,
} from "../../domain/memory.js";
import { ForgeError } from "../../domain/errors.js";
import type { MemoryService } from "../service.js";
import type { MemoryCommitService } from "../commit.js";
import { sha256Hex } from "../files.js";

/**
 * Issue #39 (M06) phase B: manual review of curator proposals.
 *
 * Approval is a human decision applied through the same M02 event + commit
 * path the auto policy uses (`curator:<change_id>` event key keeps a replay
 * idempotent). CAS is re-checked before and inside the commit, so a stale
 * proposal can never overwrite newer human text: the row becomes `stale` with
 * an explicit reason and the HTTP layer returns 409 with both revisions.
 * Rejection only records the decision; it never touches a note.
 *
 * This file is new (not an edit of the existing curator modules): `apply.ts`
 * implements the opt-in auto policy only, and the coordinator's boundary
 * forbids editing the existing curator files. Reusing their record/commit
 * patterns here keeps one commit path and one source-event identity.
 */

export interface CuratorReviewResult {
  change_id: string;
  state: "applied" | "rejected";
  note_id: string | null;
  revision: number | null;
  reason: string | null;
}

export class CuratorReview {
  constructor(
    readonly deps: {
      db: Kysely<DB>;
      service: MemoryService;
      commits: MemoryCommitService;
    },
  ) {}

  async approve(
    identity: Identity,
    input: { spaceId: string; changeId: string; expectedRevision?: number },
  ): Promise<CuratorReviewResult> {
    const space = await this.deps.service.authorizeSpace(
      identity,
      input.spaceId,
      "write",
    );
    const change = await this.load(identity, input.spaceId, input.changeId);
    if (change.state === "stale")
      throw new ForgeError(
        "memory_proposal_stale",
        "Aday güncel değil; temel sürüm değişmiş.",
        409,
        undefined,
        {
          change_id: change.id,
          reason: change.reason ?? "base_revision_conflict",
        },
      );
    if (change.state !== "proposed")
      throw new ForgeError(
        "memory_proposal_state",
        "Aday bu durumda onaylanamaz.",
        409,
        undefined,
        { change_id: change.id, state: change.state },
      );
    // A crash may leave a committed event with the row still proposed: replay
    // is finalized from the durable event instead of writing a second time.
    const existingEvent = await this.deps.db
      .selectFrom("memory_events")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("source_event_key", "=", `curator:${change.id}`)
      .executeTakeFirst();
    if (existingEvent?.state === "committed") {
      const revision = existingEvent.committed_revision ?? null;
      const replayedNote = existingEvent.note_id ?? change.note_id;
      await this.markApplied(identity, change.id, revision, replayedNote);
      await this.audit(identity, space, "memory.curator.proposal.approved", {
        change_id: change.id,
        operation: change.operation,
        note_id: replayedNote,
        revision,
        replayed: true,
      });
      return {
        change_id: change.id,
        state: "applied",
        note_id: replayedNote,
        revision,
        reason: null,
      };
    }
    if (existingEvent)
      throw new ForgeError(
        "memory_event_conflict",
        "Adayın uygulaması zaten sürüyor.",
        409,
        undefined,
        { change_id: change.id },
      );

    let record: MemoryRecord;
    let noteId: string;
    let baseRevision: number | null;
    if (change.operation === "create") {
      noteId = change.note_id ?? randomUUID();
      baseRevision = null;
      record = this.buildCreateRecord(change, input.spaceId, noteId);
    } else if (change.operation === "link") {
      noteId = change.note_id!;
      baseRevision = change.base_revision;
      const current = await this.loadCurrentRecord(
        identity,
        input.spaceId,
        noteId,
      );
      await this.assertBase(
        identity,
        change,
        current.revision,
        input.expectedRevision,
      );
      const relation = change.relation as MemoryEdge["relation"];
      const target = change.target_note_id!;
      const edges = current.record.edges.some(
        (edge) => edge.relation === relation && edge.target === target,
      )
        ? current.record.edges
        : [...current.record.edges, { relation, target }];
      record = { ...current.record, edges };
    } else {
      // update and supersede both write a new accepted revision of the note;
      // the previous revision is superseded by the revision chain. The note
      // lifecycle is never silently retired here (see the review doc).
      noteId = change.note_id!;
      baseRevision = change.base_revision;
      const current = await this.loadCurrentRecord(
        identity,
        input.spaceId,
        noteId,
      );
      await this.assertBase(
        identity,
        change,
        current.revision,
        input.expectedRevision,
      );
      record = {
        ...current.record,
        kind: (change.kind ?? current.record.kind) as MemoryKind,
        title: change.title ?? current.record.title,
        summary: change.summary ?? current.record.summary,
        body: normalizeBody(change.body_md ?? current.record.body),
      };
    }

    const content = serializeMemoryDocument(record);
    const event = await this.deps.service.recordEvent(identity, {
      spaceId: input.spaceId,
      sourceEventKey: `curator:${change.id}`,
      sourceKind: "curator",
      contentHash: sha256Hex(content),
    });
    if (event.status === "duplicate") {
      // A completed earlier attempt is a replay, not a new write.
      if (event.event.state === "committed") {
        const revision = event.event.committed_revision ?? null;
        await this.markApplied(
          identity,
          change.id,
          revision,
          event.event.note_id ?? noteId,
        );
        await this.audit(identity, space, "memory.curator.proposal.approved", {
          change_id: change.id,
          operation: change.operation,
          note_id: event.event.note_id ?? noteId,
          revision,
          replayed: true,
        });
        return {
          change_id: change.id,
          state: "applied",
          note_id: event.event.note_id ?? noteId,
          revision,
          reason: null,
        };
      }
      throw new ForgeError(
        "memory_event_conflict",
        "Adayın uygulaması zaten sürüyor.",
        409,
        undefined,
        { change_id: change.id },
      );
    }

    let revision: number;
    try {
      const receipt = await this.deps.commits.commit({
        identity,
        spaceId: input.spaceId,
        eventId: event.event.id,
        sourceKind: "curator",
        content,
        noteId,
        baseRevision,
        kind: record.kind,
      });
      revision = receipt.revision;
    } catch (error) {
      if (
        error instanceof ForgeError &&
        error.code === "memory_revision_conflict"
      ) {
        await this.markStale(identity, change.id, "base_revision_conflict");
        const detail = (error.detail ?? {}) as Record<string, unknown>;
        throw new ForgeError(
          "memory_revision_conflict",
          "Not başka bir değişiklikle ilerlemiş; aday güncel değil.",
          409,
          undefined,
          {
            change_id: change.id,
            current_revision: detail.current_revision ?? null,
            base_revision: baseRevision,
          },
        );
      }
      throw error;
    }
    await this.markApplied(identity, change.id, revision);
    await this.audit(identity, space, "memory.curator.proposal.approved", {
      change_id: change.id,
      operation: change.operation,
      note_id: noteId,
      revision,
    });
    return {
      change_id: change.id,
      state: "applied",
      note_id: noteId,
      revision,
      reason: null,
    };
  }

  async reject(
    identity: Identity,
    input: { spaceId: string; changeId: string; reason?: string },
  ): Promise<CuratorReviewResult> {
    const space = await this.deps.service.authorizeSpace(
      identity,
      input.spaceId,
      "write",
    );
    const change = await this.load(identity, input.spaceId, input.changeId);
    if (change.state === "applied" || change.state === "shadow")
      throw new ForgeError(
        "memory_proposal_state",
        "Aday bu durumda reddedilemez.",
        409,
        undefined,
        { change_id: change.id, state: change.state },
      );
    const reason = (input.reason?.trim() || change.reason || null)?.slice(
      0,
      500,
    );
    if (change.state !== "rejected")
      await this.deps.db
        .updateTable("memory_curator_changes")
        .set({
          state: "rejected",
          reason: reason ?? null,
          updated_at: Date.now(),
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "=", input.spaceId)
        .where("id", "=", change.id)
        .where("state", "in", ["proposed", "stale"])
        .execute();
    await this.audit(identity, space, "memory.curator.proposal.rejected", {
      change_id: change.id,
      operation: change.operation,
      reason,
    });
    return {
      change_id: change.id,
      state: "rejected",
      note_id: change.note_id,
      revision: null,
      reason: reason ?? null,
    };
  }

  private buildCreateRecord(
    change: MemoryCuratorChange,
    spaceId: string,
    noteId: string,
  ): MemoryRecord {
    const now = Date.now();
    const body = normalizeBody(change.body_md ?? "");
    return {
      formatVersion: 1,
      noteId,
      spaceId,
      kind: (change.kind ?? "note") as MemoryKind,
      title: change.title ?? "Not",
      summary: change.summary,
      lifecycle: "active",
      pinned: false,
      taskStatus: null,
      verification: "declared",
      stale: null,
      sources: parseSources(change.source_refs_json),
      edges: [],
      createdAt: now,
      observedAt: now,
      validFrom: null,
      validUntil: null,
      baseRevision: null,
      revision: null,
      unknown: {},
      body,
    };
  }

  private async assertBase(
    identity: Identity,
    change: MemoryCuratorChange,
    currentRevision: number,
    expectedRevision?: number,
  ): Promise<void> {
    if (currentRevision !== change.base_revision) {
      await this.markStale(identity, change.id, "base_revision_conflict");
      throw new ForgeError(
        "memory_revision_conflict",
        "Not başka bir değişiklikle ilerlemiş; aday güncel değil.",
        409,
        undefined,
        {
          change_id: change.id,
          current_revision: currentRevision,
          base_revision: change.base_revision,
        },
      );
    }
    if (expectedRevision !== undefined && expectedRevision !== currentRevision)
      throw new ForgeError(
        "memory_revision_conflict",
        "Görüntülenen sürüm güncel değil.",
        409,
        undefined,
        {
          change_id: change.id,
          current_revision: currentRevision,
          expected_revision: expectedRevision,
        },
      );
  }

  private async load(
    identity: Identity,
    spaceId: string,
    changeId: string,
  ): Promise<MemoryCuratorChange> {
    const change = await this.deps.db
      .selectFrom("memory_curator_changes")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", spaceId)
      .where("id", "=", changeId)
      .executeTakeFirst();
    if (!change)
      throw new ForgeError(
        "memory_proposal_unavailable",
        "Öneri bulunamadı.",
        404,
      );
    return change;
  }

  private async loadCurrentRecord(
    identity: Identity,
    spaceId: string,
    noteId: string,
  ): Promise<{ record: MemoryRecord; revision: number }> {
    const note = await this.deps.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", spaceId)
      .where("id", "=", noteId)
      .executeTakeFirst();
    if (!note?.current_revision || note.deleted_at !== null)
      throw new ForgeError(
        "memory_note_unavailable",
        "Hedef not bulunamadı.",
        404,
      );
    const row = await this.deps.db
      .selectFrom("memory_note_revisions")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", spaceId)
      .where("note_id", "=", noteId)
      .where("revision", "=", note.current_revision)
      .executeTakeFirst();
    if (!row)
      throw new ForgeError(
        "memory_revision_file_missing",
        "Kabul edilmiş sürüm bulunamadı.",
        409,
      );
    const metadata = JSON.parse(row.metadata_json) as {
      record?: {
        kind?: string;
        title?: string;
        summary?: string | null;
        lifecycle?: string;
        pinned?: boolean;
        task_status?: string | null;
        verification?: string;
        stale?: boolean | null;
        sources?: MemorySource[];
        edges?: MemoryEdge[];
        created_at?: number | null;
        observed_at?: number | null;
        valid_from?: number | null;
        valid_until?: number | null;
        unknown?: Record<string, unknown>;
      };
    };
    const meta = metadata.record;
    if (!meta)
      throw new ForgeError(
        "memory_revision_metadata_missing",
        "Sürüm anlamsal metadata taşımıyor.",
        409,
      );
    const record: MemoryRecord = {
      formatVersion: 1,
      noteId,
      spaceId,
      kind: (meta.kind ?? "note") as MemoryKind,
      title: meta.title ?? "",
      summary: meta.summary ?? null,
      lifecycle: (meta.lifecycle ?? "active") as MemoryRecord["lifecycle"],
      pinned: Boolean(meta.pinned),
      taskStatus: (meta.task_status ?? null) as MemoryRecord["taskStatus"],
      verification: (meta.verification ??
        "declared") as MemoryRecord["verification"],
      stale: meta.stale ?? null,
      sources: Array.isArray(meta.sources) ? meta.sources : [],
      edges: Array.isArray(meta.edges) ? meta.edges : [],
      createdAt: meta.created_at ?? null,
      observedAt: meta.observed_at ?? null,
      validFrom: meta.valid_from ?? null,
      validUntil: meta.valid_until ?? null,
      baseRevision: note.current_revision,
      revision: note.current_revision,
      unknown: meta.unknown ?? {},
      body: row.body_md,
    };
    return { record, revision: note.current_revision };
  }

  private async markApplied(
    identity: Identity,
    changeId: string,
    revision: number | null,
    noteId?: string | null,
  ): Promise<void> {
    await this.deps.db
      .updateTable("memory_curator_changes")
      .set({
        state: "applied",
        applied_revision: revision,
        reason: null,
        ...(noteId ? { note_id: noteId } : {}),
        updated_at: Date.now(),
      })
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", changeId)
      .where("state", "=", "proposed")
      .execute();
  }

  private async markStale(
    identity: Identity,
    changeId: string,
    reason: string,
  ): Promise<void> {
    await this.deps.db
      .updateTable("memory_curator_changes")
      .set({ state: "stale", reason, updated_at: Date.now() })
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", changeId)
      .where("state", "=", "proposed")
      .execute();
  }

  private async audit(
    identity: Identity,
    space: MemorySpace,
    kind: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.db
      .insertInto("audit_events")
      .values({
        tenant_id: identity.tenantId,
        id: randomUUID(),
        user_id: identity.userId,
        project_id: space.kind === "project" ? space.project_id : null,
        kind,
        detail: JSON.stringify(detail),
        created_at: Date.now(),
      })
      .execute();
  }
}

function normalizeBody(body: string): string {
  return body.endsWith("\n") ? body : `${body}\n`;
}

function parseSources(raw: string): MemorySource[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is { source_id: string; hash?: unknown } =>
        typeof (entry as { source_id?: unknown })?.source_id === "string",
    )
    .slice(0, 100)
    .map((entry) => ({
      id: entry.source_id,
      kind: "curator-source",
      hash: typeof entry.hash === "string" ? entry.hash : undefined,
      revision: undefined,
    }));
}
