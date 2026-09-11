import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
import { MemoryService, jobScopeForSpace } from "./service.js";
import { MemorySearchService } from "./search.js";
import { MemoryIndexService } from "./index.js";
import { MemoryContextService } from "./context.js";
import { MemoryWriteService } from "./writes.js";
import type { MemoryCommitService, MemoryCommitReceipt } from "./commit.js";
import { resolveVaultRelative } from "./paths.js";
import { readTextIfExists } from "./files.js";
import { parseMemoryDocument } from "../domain/memory.js";

/**
 * Issue #36 (M03): the single application surface shared by HTTP and MCP.
 * Identity always comes from the caller's resolved session, never from the
 * payload; every method re-authorizes through `MemoryService`.
 */

export interface MemoryIngestQueue {
  /** Structural view over the production queue; the concrete kind union is
   * intentionally erased here so M03 stays independent of queue generics. */
  accept(
    identity: Identity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
  ): Promise<{ status: string; run: { id: string } }>;
}

export interface MemoryReadResult {
  note: unknown;
  revision: unknown;
  content: string | null;
  display_path: string;
  neighbors: {
    nodes: {
      note_id: string;
      space_id: string;
      revision: number;
      title: string;
      kind: string;
      depth: number;
    }[];
    edges: {
      source_note_id: string;
      relation: string;
      target_note_id: string;
    }[];
    truncated: boolean;
  } | null;
}

export class MemoryOperations {
  readonly search: MemorySearchService;
  readonly index: MemoryIndexService;
  readonly context: MemoryContextService;
  readonly writes: MemoryWriteService;

  constructor(
    readonly deps: {
      db: Kysely<DB>;
      vaultRoot: string;
      service: MemoryService;
      commits: MemoryCommitService;
      queue?: MemoryIngestQueue;
    },
  ) {
    this.search = new MemorySearchService(deps.db, deps.service);
    this.index = new MemoryIndexService(deps.db, deps.vaultRoot, deps.service);
    this.context = new MemoryContextService(deps.db, deps.service);
    this.writes = new MemoryWriteService({
      db: deps.db,
      service: deps.service,
      commits: deps.commits,
      vaultRoot: deps.vaultRoot,
    });
  }

  async contextFor(identity: Identity, input: Record<string, unknown>) {
    return this.context.context(identity, {
      spaceId: input.space_id ? String(input.space_id) : undefined,
      spaceIds: Array.isArray(input.space_ids)
        ? input.space_ids.map(String)
        : undefined,
      goal: input.goal ? String(input.goal) : undefined,
      knownRevisions: Array.isArray(input.known_revisions)
        ? (
            input.known_revisions as { note_id: string; revision: number }[]
          ).map((revision) => ({
            note_id: String(revision.note_id),
            revision: Number(revision.revision),
          }))
        : undefined,
      session_key: input.session_key ? String(input.session_key) : undefined,
      generation:
        input.generation === undefined ? undefined : Number(input.generation),
      branch: input.branch ? String(input.branch) : undefined,
      worktree: input.worktree ? String(input.worktree) : undefined,
      maxTokens:
        input.max_tokens === undefined ? undefined : Number(input.max_tokens),
    });
  }

  async update(identity: Identity, input: Record<string, unknown>) {
    return this.writes.update(identity, input as never);
  }

  async link(identity: Identity, input: Record<string, unknown>) {
    return this.writes.link(identity, input as never);
  }

  async checkpoint(identity: Identity, input: Record<string, unknown>) {
    return this.writes.checkpoint(identity, input as never);
  }

  async recall(identity: Identity, input: Record<string, unknown>) {
    return this.search.search(identity, {
      query: String(input.query ?? ""),
      spaceId: input.space_id ? String(input.space_id) : undefined,
      spaceIds: Array.isArray(input.space_ids)
        ? input.space_ids.map(String)
        : undefined,
      kinds: Array.isArray(input.kinds) ? input.kinds.map(String) : undefined,
      graphDepth:
        input.graph_depth === undefined ? undefined : Number(input.graph_depth),
      limit: input.limit === undefined ? undefined : Number(input.limit),
      after: input.cursor ? String(input.cursor) : undefined,
      asOf: input.as_of ? Date.parse(String(input.as_of)) : undefined,
    });
  }

  async read(
    identity: Identity,
    input: {
      spaceId: string;
      noteId: string;
      revision?: number;
      neighbors?: number;
    },
  ): Promise<MemoryReadResult> {
    const space = await this.deps.service.authorizeSpace(
      identity,
      input.spaceId,
      "read",
    );
    if (input.revision !== undefined) {
      const row = await this.deps.db
        .selectFrom("memory_note_revisions")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "=", space.id)
        .where("note_id", "=", input.noteId)
        .where("revision", "=", input.revision)
        .executeTakeFirst();
      if (!row)
        throw new ForgeError(
          "memory_note_unavailable",
          "Sürüm bulunamadı.",
          404,
        );
      const content =
        row.file_path === null
          ? null
          : await readTextIfExists(
              resolveVaultRelative(this.deps.vaultRoot, row.file_path),
            );
      const note = await this.deps.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "=", space.id)
        .where("id", "=", input.noteId)
        .executeTakeFirst();
      if (!note)
        throw new ForgeError("memory_note_unavailable", "Not bulunamadı.", 404);
      return {
        note,
        revision: row,
        content,
        display_path: `${space.id}/${input.noteId}/${row.revision}`,
        neighbors: null,
      };
    }
    const current = await this.deps.service.readNote(identity, {
      spaceId: input.spaceId,
      noteId: input.noteId,
    });
    const neighbors =
      input.neighbors && input.neighbors > 0
        ? await this.search
            .graph(identity, {
              spaceId: input.spaceId,
              noteId: input.noteId,
              depth: 1,
              maxNodes: Math.min(input.neighbors, 10),
              maxEdges: Math.min(input.neighbors * 4, 40),
            })
            .catch(() => null)
        : null;
    return {
      note: current.note,
      revision: current.revision,
      content: current.content,
      display_path: current.display_path,
      neighbors: neighbors
        ? {
            nodes: neighbors.nodes.map((node) => ({
              note_id: node.note_id,
              space_id: node.space_id,
              revision: node.revision,
              title: node.title,
              kind: node.kind,
              depth: node.depth,
            })),
            edges: neighbors.edges,
            truncated: neighbors.truncated,
          }
        : null,
    };
  }

  async graph(identity: Identity, input: Record<string, unknown>) {
    return this.search.graph(identity, {
      spaceId: String(input.space_id ?? ""),
      noteId: String(input.note_id ?? ""),
      depth: input.depth === undefined ? undefined : Number(input.depth),
      maxNodes:
        input.max_nodes === undefined ? undefined : Number(input.max_nodes),
      maxEdges:
        input.max_edges === undefined ? undefined : Number(input.max_edges),
    });
  }

  async rebuild(identity: Identity, input: Record<string, unknown>) {
    return this.index.rebuild(identity, {
      spaceId: input.space_id ? String(input.space_id) : undefined,
      after: input.after ? String(input.after) : undefined,
      batchSize:
        input.batch_size === undefined ? undefined : Number(input.batch_size),
    });
  }

  /**
   * Durable accept path shared by MCP writes: enqueue, then optionally wait a
   * bounded time for the commit receipt. A timeout returns `queued`, never a
   * fake success; the event can be followed by `memory_read`/receipt.
   */
  async accept(
    identity: Identity,
    input: {
      spaceId: string;
      content: string;
      sourceKind: string;
      sourceEventKey?: string;
      noteId?: string | null;
      baseRevision?: number | null;
      kind?: string;
      waitMs?: number;
    },
  ): Promise<{
    status: "accepted" | "duplicate" | "committed" | "rejected" | "queued";
    run_id: string;
    event_id: string | null;
    receipt: MemoryCommitReceipt | null;
    error_code: string | null;
  }> {
    if (!this.deps.queue)
      throw new ForgeError(
        "memory_commit_unavailable",
        "Hafıza kuyruğu yapılandırılmadı.",
        503,
      );
    const space = await this.deps.service.authorizeSpace(
      identity,
      input.spaceId,
      "write",
    );
    const contentHash = createHash("sha256")
      .update(input.content)
      .digest("hex");
    const sourceEventKey = input.sourceEventKey ?? `mcp:${randomUUID()}`;
    const accepted = await this.deps.queue.accept(identity, {
      scope: jobScopeForSpace(space),
      kind: "memory_ingest",
      key: createHash("sha256")
        .update(`${input.spaceId}\u0000${sourceEventKey}`)
        .digest("hex"),
      payload: {
        spaceId: input.spaceId,
        sourceEventKey,
        sourceKind: input.sourceKind,
        contentHash,
        content: input.content,
        ...(input.noteId ? { noteId: input.noteId } : {}),
        ...(input.baseRevision !== undefined && input.baseRevision !== null
          ? { baseRevision: input.baseRevision }
          : {}),
        ...(input.kind ? { kind: input.kind } : {}),
      },
    });
    const runId = accepted.run.id;
    const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), 10000);
    let eventId: string | null = null;
    if (waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const event = await this.deps.db
          .selectFrom("memory_events")
          .selectAll()
          .where("tenant_id", "=", identity.tenantId)
          .where("space_id", "=", input.spaceId)
          .where("source_event_key", "=", sourceEventKey)
          .executeTakeFirst();
        if (event) {
          eventId = event.id;
          if (event.state === "committed")
            return {
              status: "committed",
              run_id: runId,
              event_id: event.id,
              receipt: event.receipt_json
                ? (JSON.parse(event.receipt_json) as MemoryCommitReceipt)
                : null,
              error_code: null,
            };
          if (event.state === "rejected")
            return {
              status: "rejected",
              run_id: runId,
              event_id: event.id,
              receipt: null,
              error_code: event.error_code,
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return {
      status: accepted.status === "duplicate" ? "duplicate" : "queued",
      run_id: runId,
      event_id: eventId,
      receipt: null,
      error_code: null,
    };
  }

  /** Read the current accepted revision record for typed edits. */
  async currentRecord(
    identity: Identity,
    spaceId: string,
    noteId: string,
  ): Promise<{
    record: ReturnType<typeof parseMemoryDocument>;
    revision: number;
  }> {
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
    if (!row?.file_path)
      throw new ForgeError(
        "memory_revision_file_missing",
        "Kabul edilmiş sürüm dosyası bulunamadı.",
        409,
      );
    const text = await readTextIfExists(
      resolveVaultRelative(this.deps.vaultRoot, row.file_path),
    );
    if (text === null)
      throw new ForgeError(
        "memory_revision_file_missing",
        "Kabul edilmiş sürüm dosyası bulunamadı.",
        409,
      );
    return {
      record: parseMemoryDocument(text),
      revision: note.current_revision,
    };
  }
}
