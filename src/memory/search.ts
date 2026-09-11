import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB, MemoryIndexHead } from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
import { MemoryService } from "./service.js";
import {
  MEMORY_QUERY_TERM_LIMIT,
  normalizeMemoryText,
  tokenizeMemoryText,
} from "./text.js";

/**
 * Issue #36 (M03): sourced lexical search with bounded typed-graph expansion.
 *
 * - Candidate discovery is global over the derived term index; the scope
 *   filter is applied before scoring/top-k and re-checked on every graph step.
 * - Every returned revision is verified against the current note head; stale
 *   index hits are excluded and counted (`index.stale`), never presented as
 *   current. `index.pending_events` reports index lag.
 * - Catalog navigation stays separate (`MemoryService.listNotes`); search
 *   never validates only the first N catalog ids.
 */

export interface MemorySearchInput {
  query: string;
  spaceId?: string;
  spaceIds?: string[];
  kinds?: string[];
  /** 0 disables graph expansion (default 1). */
  graphDepth?: number;
  limit?: number;
  after?: string;
}

export interface MemorySearchCard {
  note_id: string;
  space_id: string;
  revision: number;
  current_revision: number;
  title: string;
  kind: string;
  snippet: string;
  score: number;
  match_reason: string[];
  lifecycle: string;
  pinned: boolean;
  verification: string;
  sources: unknown[];
  stale: boolean;
}

export interface MemorySearchResult {
  items: MemorySearchCard[];
  next: string | null;
  index: { stale: number; pending_events: number; indexed_at: number | null };
}

const CURSOR_VERSION = 1;

export class MemorySearchService {
  constructor(
    readonly db: Kysely<DB>,
    readonly service: MemoryService = new MemoryService(db),
  ) {}

  private async authorizedSpaces(
    identity: Identity,
    input: MemorySearchInput,
  ): Promise<string[]> {
    const requested = [
      ...new Set([
        ...(input.spaceId ? [input.spaceId] : []),
        ...(input.spaceIds ?? []),
      ]),
    ];
    if (requested.length > 0) {
      for (const spaceId of requested)
        await this.service.authorizeSpace(identity, spaceId, "read");
      return requested;
    }
    const spaces = await this.service.listSpaces(identity, { limit: 100 });
    return spaces.items.map((space) => space.id);
  }

  async search(
    identity: Identity,
    input: MemorySearchInput,
  ): Promise<MemorySearchResult> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
    const terms = [...new Set(tokenizeMemoryText(input.query))].slice(
      0,
      MEMORY_QUERY_TERM_LIMIT,
    );
    const spaces = await this.authorizedSpaces(identity, input);
    if (terms.length === 0 || spaces.length === 0)
      return {
        items: [],
        next: null,
        index: { stale: 0, pending_events: 0, indexed_at: null },
      };
    const cursor = this.parseCursor(input.after, {
      query: input.query,
      spaces,
    });
    if (cursor === "invalid")
      throw new ForgeError("invalid_cursor", "Arama imleci geçersiz.", 400);

    // Global aday keşfi: tüm kapsamlarda terim eşleşmeleri; skor SQL'de
    // hesaplanır ve yalnız sıralı ilk dilim zenginleştirilir.
    const lexicalExpr = sql<number>`sum(case when t.field = 'title' then t.frequency * 3 when t.field = 'kind' then t.frequency * 2 else t.frequency end)`;
    const candidates = await this.db
      .selectFrom("memory_index_terms as t")
      .select(["t.space_id", "t.note_id", "t.revision", "t.content_hash"])
      .select(lexicalExpr.as("lexical"))
      .where("t.tenant_id", "=", identity.tenantId)
      .where("t.term", "in", terms)
      .where("t.space_id", "in", spaces)
      .groupBy(["t.space_id", "t.note_id", "t.revision", "t.content_hash"])
      .orderBy(
        sql`sum(case when t.field = 'title' then t.frequency * 3 when t.field = 'kind' then t.frequency * 2 else t.frequency end) desc`,
      )
      .orderBy("t.note_id")
      .limit(limit * 4 + 20)
      .execute();
    if (candidates.length === 0)
      return {
        items: [],
        next: null,
        index: await this.indexStatus(identity, spaces, 0),
      };

    const noteIds = [...new Set(candidates.map((row) => row.note_id))];
    const heads = await this.db
      .selectFrom("memory_index_heads")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaces)
      .where("note_id", "in", noteIds)
      .execute();
    const headByKey = new Map(
      heads.map((head) => [`${head.space_id}\u0000${head.note_id}`, head]),
    );
    const notes = await this.db
      .selectFrom("memory_notes")
      .select(["id", "space_id", "current_revision", "deleted_at", "lifecycle"])
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaces)
      .where("id", "in", noteIds)
      .execute();
    const noteByKey = new Map(
      notes.map((note) => [`${note.space_id}\u0000${note.id}`, note]),
    );

    const normalizedQuery = normalizeMemoryText(input.query).trim();
    let stale = 0;
    const scored: {
      card: Omit<MemorySearchCard, "snippet" | "sources" | "stale">;
      head: MemoryIndexHead;
    }[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.space_id}\u0000${candidate.note_id}`;
      const head = headByKey.get(key);
      const note = noteByKey.get(key);
      if (!head || !note || note.deleted_at !== null) {
        stale += 1;
        continue;
      }
      // Head doğrulaması: indeks satırı güncel head ile eşleşmiyorsa stale.
      if (
        note.current_revision !== head.revision ||
        head.revision !== candidate.revision ||
        head.content_hash !== candidate.content_hash ||
        head.lifecycle === "superseded" ||
        head.lifecycle === "archived"
      ) {
        stale += 1;
        continue;
      }
      if (input.kinds && !input.kinds.includes(head.kind)) continue;
      const lexical = Number(candidate.lexical);
      let score = lexical;
      const reasons: string[] = [`lexical:${terms.join("+")}`];
      if (normalizeMemoryText(head.title).trim() === normalizedQuery) {
        score += 5;
        reasons.push("title:exact");
      }
      if (head.pinned) {
        score += 0.5;
        reasons.push("pinned");
      }
      scored.push({
        head,
        card: {
          note_id: head.note_id,
          space_id: head.space_id,
          revision: head.revision,
          current_revision: note.current_revision!,
          title: head.title,
          kind: head.kind,
          score,
          match_reason: reasons,
          lifecycle: head.lifecycle,
          pinned: Boolean(head.pinned),
          verification: head.verification,
        },
      });
    }

    // Sınırlı typed graph genişlemesi; her adımda alan yetkisi yeniden.
    const graphDepth = Math.min(Math.max(input.graphDepth ?? 1, 0), 2);
    const included = new Set(
      scored.map(
        (entry) => `${entry.card.space_id}\u0000${entry.card.note_id}`,
      ),
    );
    if (graphDepth > 0 && scored.length > 0) {
      const expansions = await this.expandGraph(
        identity,
        spaces,
        scored.slice(0, 5).map((entry) => entry.card.note_id),
        graphDepth,
        8,
        included,
      );
      for (const expansion of expansions) scored.push(expansion);
    }

    scored.sort(
      (a, b) =>
        b.card.score - a.card.score ||
        a.card.note_id.localeCompare(b.card.note_id),
    );

    let filtered = scored;
    if (cursor) {
      filtered = scored.filter(
        (entry) =>
          entry.card.score < cursor.score ||
          (entry.card.score === cursor.score &&
            entry.card.note_id > cursor.noteId),
      );
    }
    const page = filtered.slice(0, limit);
    const items: MemorySearchCard[] = [];
    for (const entry of page) {
      items.push({
        ...entry.card,
        snippet: await this.snippet(entry.head, terms),
        sources: this.parseSources(entry.head.sources_json),
        stale: false,
      });
    }
    const next =
      filtered.length > limit && items.length > 0
        ? this.encodeCursor({
            query: input.query,
            spaces,
            score: items[items.length - 1]!.score,
            noteId: items[items.length - 1]!.note_id,
          })
        : null;
    return {
      items,
      next,
      index: await this.indexStatus(identity, spaces, stale),
    };
  }

  private async expandGraph(
    identity: Identity,
    spaces: string[],
    origins: string[],
    depth: number,
    maxNodes: number,
    included: Set<string>,
  ): Promise<
    {
      card: Omit<MemorySearchCard, "snippet" | "sources" | "stale">;
      head: MemoryIndexHead;
    }[]
  > {
    const results: {
      card: Omit<MemorySearchCard, "snippet" | "sources" | "stale">;
      head: MemoryIndexHead;
    }[] = [];
    const frontier = [...origins];
    for (let hop = 0; hop < depth && results.length < maxNodes; hop += 1) {
      const edges = await this.db
        .selectFrom("memory_index_edges")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "in", spaces)
        .where((eb) =>
          eb.or([
            eb("source_note_id", "in", frontier),
            eb("target_note_id", "in", frontier),
          ]),
        )
        .limit(200)
        .execute();
      const nextFrontier: string[] = [];
      const frontierSet = new Set(frontier);
      for (const edge of edges) {
        if (results.length >= maxNodes) break;
        const candidateId = frontierSet.has(edge.source_note_id)
          ? edge.target_note_id
          : edge.source_note_id;
        // Kenar kaynağın alanında saklanır; hedef başka yetkili alanda
        // olabilir. Head yalnız yetkili alanlar içinde aranır (sızıntı yok).
        const head = await this.db
          .selectFrom("memory_index_heads")
          .selectAll()
          .where("tenant_id", "=", identity.tenantId)
          .where("space_id", "in", spaces)
          .where("note_id", "=", candidateId)
          .executeTakeFirst();
        if (!head) continue;
        const candidateKey = `${head.space_id}\u0000${candidateId}`;
        if (included.has(candidateKey)) continue;
        const note = await this.db
          .selectFrom("memory_notes")
          .select(["current_revision", "deleted_at", "lifecycle"])
          .where("tenant_id", "=", identity.tenantId)
          .where("space_id", "=", head.space_id)
          .where("id", "=", candidateId)
          .executeTakeFirst();
        if (
          !note ||
          note.deleted_at !== null ||
          note.current_revision !== head.revision ||
          head.lifecycle === "superseded" ||
          head.lifecycle === "archived"
        )
          continue;
        included.add(candidateKey);
        nextFrontier.push(candidateId);
        results.push({
          head,
          card: {
            note_id: head.note_id,
            space_id: head.space_id,
            revision: head.revision,
            current_revision: note.current_revision!,
            title: head.title,
            kind: head.kind,
            score: 0.3 / (hop + 1),
            match_reason: [`graph:${edge.relation}`, `depth:${hop + 1}`],
            lifecycle: head.lifecycle,
            pinned: Boolean(head.pinned),
            verification: head.verification,
          },
        });
      }
      frontier.length = 0;
      frontier.push(...nextFrontier);
      if (frontier.length === 0) break;
    }
    return results;
  }

  private async snippet(
    head: MemoryIndexHead,
    terms: string[],
  ): Promise<string> {
    const revision = await this.db
      .selectFrom("memory_note_revisions")
      .select(["body_md"])
      .where("tenant_id", "=", head.tenant_id)
      .where("space_id", "=", head.space_id)
      .where("note_id", "=", head.note_id)
      .where("revision", "=", head.revision)
      .executeTakeFirst();
    const body = revision?.body_md ?? "";
    const normalized = normalizeMemoryText(body);
    let index = -1;
    for (const term of terms) {
      const found = normalized.indexOf(term);
      if (found >= 0 && (index < 0 || found < index)) index = found;
    }
    const start = index < 0 ? 0 : Math.max(0, index - 80);
    const raw = body
      .slice(start, start + 240)
      .replace(/\s+/g, " ")
      .trim();
    return raw.length < body.trim().length ? `${raw}…` : raw;
  }

  private parseSources(sourcesJson: string): unknown[] {
    try {
      const parsed = JSON.parse(sourcesJson) as unknown;
      return Array.isArray(parsed) ? parsed.slice(0, 10) : [];
    } catch {
      return [];
    }
  }

  private async indexStatus(
    identity: Identity,
    spaces: string[],
    stale: number,
  ): Promise<{
    stale: number;
    pending_events: number;
    indexed_at: number | null;
  }> {
    const pending = await this.db
      .selectFrom("memory_events")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaces)
      .where("state", "=", "committed")
      .where("indexed_at", "is", null)
      .executeTakeFirstOrThrow();
    const newest = await this.db
      .selectFrom("memory_index_heads")
      .select((eb) => eb.fn.max("indexed_at").as("at"))
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "in", spaces)
      .executeTakeFirst();
    return {
      stale,
      pending_events: Number(pending.n),
      indexed_at: newest?.at == null ? null : Number(newest.at),
    };
  }

  private cursorKey(query: string, spaces: string[]): string {
    return createHash("sha256")
      .update(
        `${normalizeMemoryText(query)}\u0000${[...spaces].sort().join(",")}`,
      )
      .digest("hex");
  }

  private encodeCursor(input: {
    query: string;
    spaces: string[];
    score: number;
    noteId: string;
  }): string {
    return Buffer.from(
      JSON.stringify({
        v: CURSOR_VERSION,
        k: this.cursorKey(input.query, input.spaces),
        s: input.score,
        n: input.noteId,
      }),
    ).toString("base64url");
  }

  private parseCursor(
    raw: string | undefined,
    scope: { query: string; spaces: string[] },
  ): { score: number; noteId: string } | "invalid" | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(raw, "base64url").toString("utf8"),
      ) as {
        v?: number;
        k?: string;
        s?: number;
        n?: string;
      };
      if (
        parsed.v !== CURSOR_VERSION ||
        parsed.k !== this.cursorKey(scope.query, scope.spaces) ||
        typeof parsed.s !== "number" ||
        typeof parsed.n !== "string"
      )
        return "invalid";
      return { score: parsed.s, noteId: parsed.n };
    } catch {
      return "invalid";
    }
  }

  /**
   * Bounded typed subgraph for the UI/M04. Unauthorized or missing target
   * notes are omitted entirely, so no name or count leaks across scopes.
   */
  async graph(
    identity: Identity,
    input: {
      spaceId: string;
      noteId: string;
      depth?: number;
      maxNodes?: number;
      maxEdges?: number;
    },
  ) {
    await this.service.authorizeSpace(identity, input.spaceId, "read");
    const depth = Math.min(Math.max(input.depth ?? 2, 0), 2);
    const maxNodes = Math.min(Math.max(input.maxNodes ?? 25, 1), 50);
    const maxEdges = Math.min(Math.max(input.maxEdges ?? 50, 1), 100);
    const spaces = (
      await this.service.listSpaces(identity, { limit: 100 })
    ).items.map((space) => space.id);
    const nodes = new Map<
      string,
      {
        note_id: string;
        space_id: string;
        revision: number;
        title: string;
        kind: string;
        depth: number;
        pinned: boolean;
      }
    >();
    const edges: {
      source_note_id: string;
      relation: string;
      target_note_id: string;
    }[] = [];
    const edgeKeys = new Set<string>();
    const origin = await this.db
      .selectFrom("memory_index_heads")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("space_id", "=", input.spaceId)
      .where("note_id", "=", input.noteId)
      .executeTakeFirst();
    if (!origin)
      throw new ForgeError("memory_note_unavailable", "Not bulunamadı.", 404);
    nodes.set(`${origin.space_id}\u0000${origin.note_id}`, {
      note_id: origin.note_id,
      space_id: origin.space_id,
      revision: origin.revision,
      title: origin.title,
      kind: origin.kind,
      depth: 0,
      pinned: Boolean(origin.pinned),
    });
    let frontier = [origin.note_id];
    let truncated = false;
    for (let hop = 0; hop < depth; hop += 1) {
      if (frontier.length === 0 || nodes.size >= maxNodes) break;
      const rows = await this.db
        .selectFrom("memory_index_edges")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "in", spaces)
        .where((eb) =>
          eb.or([
            eb("source_note_id", "in", frontier),
            eb("target_note_id", "in", frontier),
          ]),
        )
        .orderBy("source_note_id")
        .limit(maxEdges * 2)
        .execute();
      if (rows.length >= maxEdges * 2) truncated = true;
      const next: string[] = [];
      const frontierSet = new Set(frontier);
      for (const edge of rows) {
        if (edges.length >= maxEdges) {
          truncated = true;
          break;
        }
        const other = frontierSet.has(edge.source_note_id)
          ? edge.target_note_id
          : edge.source_note_id;
        // Hedef not yalnız yetkili alanlar içinde ve canlıysa düğüme girer;
        // kenar kaynağın alanında saklansa da hedef başka yetkili alanda
        // olabilir.
        const head = await this.db
          .selectFrom("memory_index_heads")
          .selectAll()
          .where("tenant_id", "=", identity.tenantId)
          .where("space_id", "in", spaces)
          .where("note_id", "=", other)
          .executeTakeFirst();
        if (!head) continue;
        const note = await this.db
          .selectFrom("memory_notes")
          .select(["deleted_at", "current_revision", "lifecycle"])
          .where("tenant_id", "=", identity.tenantId)
          .where("space_id", "=", head.space_id)
          .where("id", "=", other)
          .executeTakeFirst();
        if (
          !note ||
          note.deleted_at !== null ||
          note.current_revision !== head.revision ||
          head.lifecycle === "superseded" ||
          head.lifecycle === "archived"
        )
          continue;
        const edgeKey = `${edge.source_note_id}\u0000${edge.relation}\u0000${edge.target_note_id}`;
        if (edgeKeys.has(edgeKey)) continue;
        edgeKeys.add(edgeKey);
        edges.push({
          source_note_id: edge.source_note_id,
          relation: edge.relation,
          target_note_id: edge.target_note_id,
        });
        const nodeKey = `${head.space_id}\u0000${head.note_id}`;
        if (!nodes.has(nodeKey)) {
          if (nodes.size >= maxNodes) {
            truncated = true;
            continue;
          }
          nodes.set(nodeKey, {
            note_id: head.note_id,
            space_id: head.space_id,
            revision: head.revision,
            title: head.title,
            kind: head.kind,
            depth: hop + 1,
            pinned: Boolean(head.pinned),
          });
          next.push(other);
        }
      }
      frontier = next;
    }
    return {
      origin: {
        note_id: origin.note_id,
        space_id: origin.space_id,
        revision: origin.revision,
      },
      nodes: [...nodes.values()],
      edges,
      truncated,
    };
  }
}
