import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
import { MemoryService } from "./service.js";

/**
 * Issue #36 (M03): the incremental context compiler.
 *
 * Builds a sourced, budgeted startup/delta package from the same authorized
 * snapshot as search: active tasks, blockers, recent decisions, pins and a
 * sourced continuation step. Every card carries note_id + revision + kind +
 * snippet + match reason + sources. There is no real tokenizer in this
 * repository, so sizes are explicitly a bytes/2.5 ESTIMATE with an additional
 * byte limit; character counts are never reported as tokens. The compiler
 * only *offers* revisions: delivery must be declared back via
 * `known_revisions`, and unchanged revisions are omitted from the delta.
 */

export const MEMORY_CONTEXT_START_TOKENS = 1024;
export const MEMORY_CONTEXT_MAX_CARDS = 8;
/**
 * Conservative byte-based token estimate. The benchmark harness measures with
 * `utf8_bytes / 2.5`; using the same divisor (instead of 3) keeps the hard
 * byte limit directly comparable to the frozen budget thresholds. It is an
 * estimate, never a character count.
 */
export const MEMORY_CONTEXT_BYTES_PER_TOKEN = 2.5;

export interface MemoryContextInput {
  spaceId?: string;
  spaceIds?: string[];
  goal?: string;
  knownRevisions?: { note_id: string; revision: number }[];
  session_key?: string;
  generation?: number;
  branch?: string;
  worktree?: string;
  maxTokens?: number;
}

export interface ContextCard {
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

export class MemoryContextService {
  constructor(
    readonly db: Kysely<DB>,
    readonly service: MemoryService = new MemoryService(db),
  ) {}

  async context(identity: Identity, input: MemoryContextInput) {
    const maxTokens = Math.min(
      Math.max(input.maxTokens ?? MEMORY_CONTEXT_START_TOKENS, 128),
      8192,
    );
    const byteLimit = maxTokens * MEMORY_CONTEXT_BYTES_PER_TOKEN;
    const requested = [
      ...new Set([
        ...(input.spaceId ? [input.spaceId] : []),
        ...(input.spaceIds ?? []),
      ]),
    ];
    const spaces =
      requested.length > 0
        ? await (async () => {
            for (const spaceId of requested)
              await this.service.authorizeSpace(identity, spaceId, "read");
            return requested;
          })()
        : (await this.service.listSpaces(identity, { limit: 100 })).items.map(
            (space) => space.id,
          );
    const known = new Set(
      (input.knownRevisions ?? []).map(
        (revision) => `${revision.note_id}\u0000${revision.revision}`,
      ),
    );
    const empty = {
      envelope: {
        version: 1 as const,
        generated_at: Date.now(),
        session_key: input.session_key ?? null,
        generation: input.generation ?? null,
        branch: input.branch ?? null,
        worktree: input.worktree ?? null,
        package_hash: createHash("sha256").update("empty").digest("hex"),
        token_estimator: "bytes/2.5 (estimate; no tokenizer installed)",
      },
      cards: [] as ContextCard[],
      sections: {
        active_tasks: [] as string[],
        blockers: [] as string[],
        recent_decisions: [] as string[],
        pins: [] as string[],
        continuation: null as string | null,
      },
      truncated: false,
      continuation_note: null as { note_id: string; revision: number } | null,
      offered: [] as {
        note_id: string;
        revision: number;
        content_hash: string;
      }[],
    };
    if (spaces.length === 0) return empty;

    const heads = await this.db
      .selectFrom("memory_index_heads")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaces)
      .where("lifecycle", "=", "active")
      .execute();
    const noteIds = [...new Set(heads.map((head) => head.note_id))];
    if (noteIds.length === 0) return empty;
    const notes = await this.db
      .selectFrom("memory_notes")
      .select([
        "id",
        "space_id",
        "current_revision",
        "deleted_at",
        "updated_at",
      ])
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaces)
      .where("id", "in", noteIds)
      .execute();
    const noteByKey = new Map(
      notes.map((note) => [`${note.space_id}\u0000${note.id}`, note]),
    );
    const fresh = heads.filter((head) => {
      const note = noteByKey.get(`${head.space_id}\u0000${head.note_id}`);
      return (
        note &&
        note.deleted_at === null &&
        note.current_revision === head.revision
      );
    });

    const bodies = await this.loadBodies(
      identity.tenantId,
      fresh.map((head) => ({
        space_id: head.space_id,
        note_id: head.note_id,
        revision: head.revision,
      })),
    );
    const bodyByKey = new Map(
      bodies.map((row) => [
        `${row.space_id}\u0000${row.note_id}\u0000${row.revision}`,
        row.body_md,
      ]),
    );

    type Candidate = {
      head: (typeof fresh)[number];
      reason: string;
      priority: number;
    };
    const candidates: Candidate[] = [];
    const updatedAt = (head: (typeof fresh)[number]) =>
      noteByKey.get(`${head.space_id}\u0000${head.note_id}`)?.updated_at ?? 0;
    const tasks = fresh
      .filter(
        (head) =>
          head.kind === "task" &&
          (head.task_status === "doing" || head.task_status === "blocked"),
      )
      .sort((a, b) => updatedAt(b) - updatedAt(a));
    for (const head of tasks)
      candidates.push({
        head,
        reason: head.task_status === "blocked" ? "blocker:task" : "active_task",
        priority: head.task_status === "blocked" ? 0 : 1,
      });
    const decisions = fresh
      .filter((head) => head.kind === "decision")
      .sort((a, b) => updatedAt(b) - updatedAt(a))
      .slice(0, 5);
    for (const head of decisions)
      candidates.push({ head, reason: "recent_decision", priority: 2 });
    const pinned = fresh
      .filter((head) => Boolean(head.pinned))
      .sort((a, b) => updatedAt(b) - updatedAt(a))
      .slice(0, 10);
    for (const head of pinned)
      candidates.push({ head, reason: "pinned", priority: 3 });
    const others = fresh
      .filter(
        (head) =>
          !tasks.includes(head) &&
          !decisions.includes(head) &&
          !pinned.includes(head),
      )
      .sort((a, b) => updatedAt(b) - updatedAt(a))
      .slice(0, 10);
    for (const head of others)
      candidates.push({ head, reason: "sourced_context", priority: 4 });

    // Aday kartları öncelik sırasıyla seçilir; ardından bütçe TÜM pakete
    // (zarf + kartlar + bölümler + offered + devam bilgisi) uygulanır.
    const offerable = candidates.filter(
      (candidate) =>
        !known.has(`${candidate.head.note_id}\u0000${candidate.head.revision}`),
    );
    let truncated = offerable.length > MEMORY_CONTEXT_MAX_CARDS;
    let continuationNote: { note_id: string; revision: number } | null =
      offerable.length > MEMORY_CONTEXT_MAX_CARDS
        ? {
            note_id: offerable[MEMORY_CONTEXT_MAX_CARDS]!.head.note_id,
            revision: offerable[MEMORY_CONTEXT_MAX_CARDS]!.head.revision,
          }
        : null;
    const cards: ContextCard[] = offerable
      .slice(0, MEMORY_CONTEXT_MAX_CARDS)
      .map((candidate) => {
        const body =
          bodyByKey.get(
            `${candidate.head.space_id}\u0000${candidate.head.note_id}\u0000${candidate.head.revision}`,
          ) ?? "";
        const card: ContextCard = {
          note_id: candidate.head.note_id,
          space_id: candidate.head.space_id,
          revision: candidate.head.revision,
          kind: candidate.head.kind,
          title: candidate.head.title,
          snippet: body.replace(/\s+/g, " ").trim().slice(0, 240),
          match_reason: candidate.reason,
          sources: parseJsonArray(candidate.head.sources_json),
          verification: candidate.head.verification,
          pinned: Boolean(candidate.head.pinned),
          task_status: candidate.head.task_status,
          lifecycle: candidate.head.lifecycle,
          token_estimate: 0,
        };
        card.token_estimate = Math.ceil(
          Buffer.byteLength(JSON.stringify(card), "utf8") /
            MEMORY_CONTEXT_BYTES_PER_TOKEN,
        );
        return card;
      });
    const sections = {
      active_tasks: tasks
        .filter((head) => head.task_status === "doing")
        .map((head) => head.note_id)
        .slice(0, 20),
      blockers: tasks
        .filter((head) => head.task_status === "blocked")
        .map((head) => head.note_id)
        .slice(0, 20),
      recent_decisions: decisions.map((head) => head.note_id).slice(0, 20),
      pins: pinned.map((head) => head.note_id).slice(0, 20),
      continuation:
        tasks.length > 0
          ? tasks[0]!.note_id
          : (fresh
              .filter((head) => head.kind === "session")
              .sort((a, b) => updatedAt(b) - updatedAt(a))[0]?.note_id ?? null),
    };
    const buildPackage = () => {
      const offered = cards
        .map((card) => ({
          note_id: card.note_id,
          revision: card.revision,
          content_hash:
            heads.find(
              (head) =>
                head.note_id === card.note_id &&
                head.revision === card.revision,
            )?.content_hash ?? "",
        }))
        .sort((a, b) => a.note_id.localeCompare(b.note_id));
      return {
        envelope: {
          version: 1 as const,
          generated_at: Date.now(),
          session_key: input.session_key ?? null,
          generation: input.generation ?? null,
          branch: input.branch ?? null,
          worktree: input.worktree ?? null,
          package_hash: createHash("sha256")
            .update(JSON.stringify(offered))
            .digest("hex"),
          token_estimator: "bytes/2.5 (estimate; no tokenizer installed)",
          budget: {
            max_tokens: maxTokens,
            used_tokens_estimate: 0,
            byte_limit: byteLimit,
          },
        },
        cards,
        sections,
        truncated,
        continuation_note: continuationNote,
        offered,
      };
    };
    // Zarf alanları için küçük bir güvenlik payı bırakılır; sığmayan kartlar
    // sondan kırpılır ve kesme açıkça raporlanır.
    const safetyBytes = 192;
    while (
      Buffer.byteLength(JSON.stringify(buildPackage()), "utf8") >
        byteLimit - safetyBytes &&
      cards.length > 0
    ) {
      const removed = cards.pop()!;
      truncated = true;
      continuationNote = {
        note_id: removed.note_id,
        revision: removed.revision,
      };
    }
    const finalPackage = buildPackage();
    finalPackage.envelope.budget.used_tokens_estimate = Math.ceil(
      Buffer.byteLength(JSON.stringify(finalPackage), "utf8") /
        MEMORY_CONTEXT_BYTES_PER_TOKEN,
    );
    return finalPackage;
  }

  private async loadBodies(
    tenantId: string,
    refs: { space_id: string; note_id: string; revision: number }[],
  ) {
    if (refs.length === 0) return [];
    return this.db
      .selectFrom("memory_note_revisions")
      .select(["space_id", "note_id", "revision", "body_md"])
      .where("tenant_id", "=", tenantId)
      .where("note_id", "in", [...new Set(refs.map((ref) => ref.note_id))])
      .execute();
  }
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.slice(0, 10) : [];
  } catch {
    return [];
  }
}
