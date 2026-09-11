import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
import {
  parseMemoryDocument,
  serializeMemoryDocument,
  type MemoryEdge,
  type MemoryKind,
  type MemoryLifecycle,
  type MemoryRecord,
  type MemoryVerification,
  type TaskStatus,
} from "../domain/memory.js";
import { MemoryService } from "./service.js";
import { MemoryCommitService, type MemoryCommitReceipt } from "./commit.js";
import { sha256Hex, readTextIfExists } from "./files.js";
import { resolveVaultRelative } from "./paths.js";

/**
 * Issue #36 (M03): typed write operations shared by HTTP and MCP.
 *
 * Every edit goes through the durable event + commit pipeline: an event is
 * accepted first, then the revision commits under the note's
 * `expected_revision` CAS. Updates are revisioned (archive/restore is a
 * lifecycle change, never a bulk purge), and checkpoints never mark a task
 * done automatically: only an explicit `status: "done"` does.
 */

export interface MemoryUpdateInput {
  space_id: string;
  note_id?: string;
  expected_revision?: number;
  kind?: MemoryKind;
  title?: string;
  summary?: string;
  body?: string;
  lifecycle?: MemoryLifecycle;
  pinned?: boolean;
  task_status?: TaskStatus;
  verification?: MemoryVerification;
  archive?: boolean;
  restore?: boolean;
  supersede_target?: string;
  event_key?: string;
}

export class MemoryWriteService {
  constructor(
    readonly deps: {
      db: Kysely<DB>;
      service: MemoryService;
      commits: MemoryCommitService;
      vaultRoot?: string;
    },
  ) {}

  private async writeRecord(
    identity: Identity,
    input: {
      spaceId: string;
      noteId: string;
      baseRevision: number | null;
      record: MemoryRecord;
      eventKey?: string;
    },
  ): Promise<MemoryCommitReceipt> {
    const content = serializeMemoryDocument(input.record);
    // M02 idempotency: aynı `event_key` + aynı içerik `duplicate` döner ve
    // commit ya pending olayı tamamlar ya da kabul edilmiş receipt'i replay
    // eder (timeout/crash sonrası tekrar deneme). Aynı anahtar FARKLI
    // içerikle kayıtlıysa `recordEvent` 409 `memory_event_conflict` fırlatır.
    const event = await this.deps.service.recordEvent(identity, {
      spaceId: input.spaceId,
      sourceEventKey: input.eventKey ?? `mcp:${randomUUID()}`,
      sourceKind: "manual",
      contentHash: sha256Hex(content),
    });
    return this.deps.commits.commit({
      identity,
      spaceId: input.spaceId,
      eventId: event.event.id,
      sourceKind: "manual",
      content,
      noteId: input.noteId,
      baseRevision: input.baseRevision,
    });
  }

  private async loadParsed(
    identity: Identity,
    spaceId: string,
    noteId: string,
  ) {
    await this.deps.service.authorizeSpace(identity, spaceId, "write");
    const note = await this.deps.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", spaceId)
      .where("id", "=", noteId)
      .executeTakeFirst();
    if (!note?.current_revision || note.deleted_at !== null)
      throw new ForgeError("memory_note_unavailable", "Not bulunamadı.", 404);
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
    // Kayıpsız düzenleme: kabul edilmiş revision dosyası tam kayıt olarak
    // (sources, unknown frontmatter, geçerlilik penceresi, created_at dahil)
    // geri okunur. Kök, servis kurulumundan da çözülebilir; dosya yoksa
    // anlamsal metadata'ya düşülür.
    const root = this.deps.vaultRoot ?? this.deps.service.vaultRoot;
    if (root && row.file_path) {
      const text = await readTextIfExists(
        resolveVaultRelative(root, row.file_path),
      );
      if (text !== null) {
        const parsed = parseMemoryDocument(text);
        if (
          parsed.status === "ok" &&
          parsed.record.noteId === noteId &&
          parsed.record.spaceId === spaceId
        )
          return {
            note,
            record: {
              ...parsed.record,
              baseRevision: note.current_revision,
              revision: note.current_revision,
            },
          };
      }
    }
    const metadata = JSON.parse(row.metadata_json) as {
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
        created_at?: number | null;
        observed_at?: number | null;
        stale?: boolean | null;
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
      lifecycle: (meta.lifecycle ?? "active") as MemoryLifecycle,
      pinned: Boolean(meta.pinned),
      taskStatus: (meta.task_status ?? null) as TaskStatus | null,
      verification: (meta.verification ?? "declared") as MemoryVerification,
      stale: meta.stale ?? null,
      sources: (meta.sources ?? []) as MemoryRecord["sources"],
      edges: (meta.edges ?? []) as MemoryEdge[],
      createdAt: meta.created_at ?? null,
      observedAt: meta.observed_at ?? null,
      validFrom: meta.valid_from ?? null,
      validUntil: meta.valid_until ?? null,
      baseRevision: note.current_revision,
      revision: note.current_revision,
      unknown: meta.unknown ?? {},
      body: row.body_md,
    };
    return { note, record };
  }

  private async audit(
    identity: Identity,
    kind: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.db
      .insertInto("audit_events")
      .values({
        tenant_id: identity.tenantId,
        id: randomUUID(),
        user_id: identity.userId,
        project_id: null,
        kind,
        detail: JSON.stringify(detail),
        created_at: Date.now(),
      })
      .execute();
  }

  async update(
    identity: Identity,
    input: MemoryUpdateInput,
  ): Promise<Record<string, unknown>> {
    const space = await this.deps.service.authorizeSpace(
      identity,
      input.space_id,
      "write",
    );
    if (input.archive) {
      const result = await this.deps.service.archiveNote(identity, {
        spaceId: space.id,
        noteId: input.note_id ?? "",
      });
      await this.audit(identity, "memory.update.applied", {
        space_id: space.id,
        note_id: result.noteId,
        status: "archived",
      });
      return { status: "archived", ...result };
    }
    if (input.restore) {
      const result = await this.deps.service.restoreNote(identity, {
        spaceId: space.id,
        noteId: input.note_id ?? "",
      });
      await this.audit(identity, "memory.update.applied", {
        space_id: space.id,
        note_id: result.noteId,
        status: "restored",
      });
      return { status: "restored", ...result };
    }
    if (!input.note_id) {
      if (!input.title)
        throw new ForgeError(
          "invalid_memory_update",
          "Yeni not için başlık zorunludur.",
          422,
        );
      const noteId = randomUUID();
      const record: MemoryRecord = {
        formatVersion: 1,
        noteId,
        spaceId: space.id,
        kind: input.kind ?? "note",
        title: input.title,
        summary: input.summary ?? null,
        lifecycle: input.lifecycle ?? "active",
        pinned: input.pinned ?? false,
        taskStatus: input.task_status ?? null,
        verification: input.verification ?? "declared",
        stale: null,
        sources: [],
        edges: [],
        createdAt: Date.now(),
        observedAt: null,
        validFrom: null,
        validUntil: null,
        baseRevision: null,
        revision: null,
        unknown: {},
        body: input.body ?? "",
      };
      const receipt = await this.writeRecord(identity, {
        spaceId: space.id,
        noteId,
        baseRevision: null,
        record,
        eventKey: input.event_key,
      });
      await this.audit(identity, "memory.update.applied", {
        space_id: space.id,
        note_id: noteId,
        revision: receipt.revision,
        status: "created",
      });
      return {
        status: receipt.status,
        note_id: noteId,
        revision: receipt.revision,
        receipt,
      };
    }
    const { record } = await this.loadParsed(identity, space.id, input.note_id);
    if (input.expected_revision !== record.revision)
      throw new ForgeError(
        "memory_revision_conflict",
        "Not başka bir değişiklikle ilerlemiş; güncel sürümü okuyun.",
        409,
        undefined,
        {
          current_revision: record.revision,
          base_revision: input.expected_revision ?? null,
        },
      );
    let next: MemoryRecord = {
      ...record,
      kind: input.kind ?? record.kind,
      title: input.title ?? record.title,
      summary: input.summary ?? record.summary,
      lifecycle: input.lifecycle ?? record.lifecycle,
      pinned: input.pinned ?? record.pinned,
      taskStatus: input.task_status ?? record.taskStatus,
      verification: input.verification ?? record.verification,
      body: input.body ?? record.body,
    };
    if (input.supersede_target) {
      await this.assertTarget(identity, space.id, input.supersede_target);
      // Sözleşme: A --SUPERSEDES--> B ise B superseded olur, A aktif kalır.
      // Kaynağı ayrıca arşivlemek isteyen açık `lifecycle`/`archive` kullanır.
      next = {
        ...next,
        edges: addEdge(next.edges, "SUPERSEDES", input.supersede_target),
      };
    }
    const receipt = await this.writeRecord(identity, {
      spaceId: space.id,
      noteId: input.note_id,
      baseRevision: record.revision,
      record: next,
      eventKey: input.event_key,
    });
    if (input.supersede_target)
      await this.markSuperseded(
        identity,
        space.id,
        input.supersede_target,
        input.note_id,
      );
    await this.audit(identity, "memory.update.applied", {
      space_id: space.id,
      note_id: input.note_id,
      revision: receipt.revision,
      status: input.supersede_target ? "superseded_target" : "patched",
      ...(input.supersede_target
        ? { supersede_target: input.supersede_target }
        : {}),
    });
    return {
      status: receipt.status,
      note_id: input.note_id,
      revision: receipt.revision,
      receipt,
    };
  }

  /**
   * Lifecycle is operational note state: `memory_notes.lifecycle` (and its
   * derived index head) changes, the target's accepted revision/file is
   * untouched. Rebuild reads lifecycle from `memory_notes`, so this survives
   * an index rebuild.
   */
  private async markSuperseded(
    identity: Identity,
    spaceId: string,
    targetNoteId: string,
    sourceNoteId: string,
  ): Promise<void> {
    const now = Date.now();
    await this.deps.db
      .updateTable("memory_notes")
      .set({
        lifecycle: "superseded",
        superseded_by: sourceNoteId,
        updated_at: now,
      })
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", spaceId)
      .where("id", "=", targetNoteId)
      .execute();
    await this.deps.db
      .updateTable("memory_index_heads")
      .set({ lifecycle: "superseded", indexed_at: now })
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", spaceId)
      .where("note_id", "=", targetNoteId)
      .execute();
  }

  async link(
    identity: Identity,
    input: {
      space_id: string;
      note_id: string;
      relation: string;
      target_note_id: string;
      remove?: boolean;
      expected_revision: number;
      event_key?: string;
    },
  ): Promise<Record<string, unknown>> {
    const space = await this.deps.service.authorizeSpace(
      identity,
      input.space_id,
      "write",
    );
    if (input.note_id === input.target_note_id)
      throw new ForgeError(
        "invalid_memory_link",
        "Not kendisine bağlanamaz.",
        422,
      );
    await this.assertTarget(identity, space.id, input.target_note_id);
    const { record } = await this.loadParsed(identity, space.id, input.note_id);
    if (input.expected_revision !== record.revision)
      throw new ForgeError(
        "memory_revision_conflict",
        "Not başka bir değişiklikle ilerlemiş; güncel sürümü okuyun.",
        409,
      );
    const relation = input.relation as MemoryEdge["relation"];
    const edges = input.remove
      ? record.edges.filter(
          (edge) =>
            !(
              edge.relation === relation && edge.target === input.target_note_id
            ),
        )
      : addEdge(record.edges, relation, input.target_note_id);
    const receipt = await this.writeRecord(identity, {
      spaceId: space.id,
      noteId: input.note_id,
      baseRevision: record.revision,
      record: { ...record, edges },
      eventKey: input.event_key,
    });
    await this.audit(identity, "memory.link.applied", {
      space_id: space.id,
      note_id: input.note_id,
      relation: input.relation,
      target_note_id: input.target_note_id,
      remove: input.remove ?? false,
      revision: receipt.revision,
    });
    return {
      status: receipt.status,
      note_id: input.note_id,
      revision: receipt.revision,
      edges,
      receipt,
    };
  }

  async checkpoint(
    identity: Identity,
    input: {
      space_id: string;
      note_id?: string;
      expected_revision?: number;
      goal: string;
      progress?: string;
      blocker?: string;
      next_step?: string;
      status?: TaskStatus;
      event_key?: string;
    },
  ): Promise<Record<string, unknown>> {
    const space = await this.deps.service.authorizeSpace(
      identity,
      input.space_id,
      "write",
    );
    // Otomatik done yok: yalnız açık `status` ile değişir.
    const status: TaskStatus =
      input.status ?? (input.blocker ? "blocked" : "doing");
    if (input.note_id) {
      const { record } = await this.loadParsed(
        identity,
        space.id,
        input.note_id,
      );
      if (record.kind !== "task")
        throw new ForgeError(
          "invalid_memory_checkpoint",
          "Checkpoint yalnız task notunu günceller.",
          422,
        );
      if (input.expected_revision !== record.revision)
        throw new ForgeError(
          "memory_revision_conflict",
          "Not başka bir değişiklikle ilerlemiş; güncel sürümü okuyun.",
          409,
        );
      const receipt = await this.writeRecord(identity, {
        spaceId: space.id,
        noteId: input.note_id,
        baseRevision: record.revision,
        record: {
          ...record,
          taskStatus: status,
          body: mergeCheckpointBody(record.body, input),
        },
        eventKey: input.event_key,
      });
      await this.audit(identity, "memory.checkpoint.recorded", {
        space_id: space.id,
        note_id: input.note_id,
        task_status: status,
        revision: receipt.revision,
      });
      return {
        status: receipt.status,
        note_id: input.note_id,
        revision: receipt.revision,
        task_status: status,
        receipt,
      };
    }
    const noteId = randomUUID();
    const record: MemoryRecord = {
      formatVersion: 1,
      noteId,
      spaceId: space.id,
      kind: "task",
      title: input.goal,
      summary: null,
      lifecycle: "active",
      pinned: false,
      taskStatus: status,
      verification: "declared",
      stale: null,
      sources: [],
      edges: [],
      createdAt: Date.now(),
      observedAt: null,
      validFrom: null,
      validUntil: null,
      baseRevision: null,
      revision: null,
      unknown: {},
      body: mergeCheckpointBody("", input),
    };
    const receipt = await this.writeRecord(identity, {
      spaceId: space.id,
      noteId,
      baseRevision: null,
      record,
      eventKey: input.event_key,
    });
    await this.audit(identity, "memory.checkpoint.recorded", {
      space_id: space.id,
      note_id: noteId,
      task_status: status,
      revision: receipt.revision,
    });
    return {
      status: receipt.status,
      note_id: noteId,
      revision: receipt.revision,
      task_status: status,
      receipt,
    };
  }

  private async assertTarget(
    identity: Identity,
    spaceId: string,
    targetNoteId: string,
  ): Promise<void> {
    const target = await this.deps.db
      .selectFrom("memory_notes")
      .select(["id"])
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", spaceId)
      .where("id", "=", targetNoteId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!target)
      throw new ForgeError(
        "memory_note_unavailable",
        "Hedef not aynı yetkili alanda bulunamadı.",
        404,
      );
  }
}

function addEdge(
  edges: readonly MemoryEdge[],
  relation: MemoryEdge["relation"],
  target: string,
): MemoryEdge[] {
  if (
    edges.some((edge) => edge.relation === relation && edge.target === target)
  )
    return [...edges];
  return [...edges, { relation, target }];
}

const CHECKPOINT_SECTIONS = [
  "Hedef",
  "İlerleme",
  "Engel",
  "Sonraki adım",
] as const;

function parseCheckpointBody(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buffer.join("\n").trim());
    buffer = [];
  };
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (
      heading &&
      (CHECKPOINT_SECTIONS as readonly string[]).includes(heading[1]!)
    ) {
      flush();
      current = heading[1]!;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return sections;
}

function mergeCheckpointBody(
  previous: string,
  input: {
    goal: string;
    progress?: string;
    blocker?: string;
    next_step?: string;
  },
): string {
  const sections = parseCheckpointBody(previous);
  sections.set("Hedef", input.goal);
  if (input.progress !== undefined) sections.set("İlerleme", input.progress);
  if (input.blocker !== undefined) sections.set("Engel", input.blocker);
  if (input.next_step !== undefined)
    sections.set("Sonraki adım", input.next_step);
  const lines: string[] = [];
  for (const name of CHECKPOINT_SECTIONS) {
    const value = sections.get(name);
    if (value === undefined) continue;
    lines.push(`## ${name}`, value, "");
  }
  return lines.join("\n");
}

export type { MemoryRecord };
