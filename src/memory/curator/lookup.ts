import type { Kysely } from "kysely";
import type { DB } from "../../storage/schema.js";

/**
 * Issue #39 (M06): `memory_lookup` backend.
 *
 * Reads only bounded note metadata/body inside the job's authorized space.
 * It never searches another space and never returns full histories.
 */
export interface CuratorLookupHit {
  id: string;
  title: string;
  summary: string | null;
  current_revision: number | null;
  updated_at: number;
}

export class CuratorLookup {
  constructor(
    readonly db: Kysely<DB>,
    readonly tenantId: string,
    readonly spaceId: string,
    readonly maxResults = 8,
  ) {}

  async search(
    query: string,
    limit = this.maxResults,
  ): Promise<CuratorLookupHit[]> {
    const bounded = Math.min(Math.max(limit, 1), this.maxResults);
    const pattern = `%${query.slice(0, 200)}%`;
    return this.db
      .selectFrom("memory_notes")
      .select(["id", "title", "summary", "current_revision", "updated_at"])
      .where("tenant_id", "=", this.tenantId)
      .where("space_id", "=", this.spaceId)
      .where("deleted_at", "is", null)
      .where((eb) =>
        eb.or([eb("title", "like", pattern), eb("summary", "like", pattern)]),
      )
      .orderBy("updated_at", "desc")
      .limit(bounded)
      .execute();
  }

  async get(noteId: string): Promise<{
    id: string;
    title: string;
    summary: string | null;
    kind: string | null;
    current_revision: number | null;
    body: string;
  } | null> {
    const note = await this.db
      .selectFrom("memory_notes")
      .select(["id", "title", "summary", "current_revision", "space_id"])
      .where("tenant_id", "=", this.tenantId)
      .where("space_id", "=", this.spaceId)
      .where("id", "=", noteId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!note || note.current_revision === null) return null;
    const revision = await this.db
      .selectFrom("memory_note_revisions")
      .select(["body_md", "kind"])
      .where("tenant_id", "=", this.tenantId)
      .where("space_id", "=", this.spaceId)
      .where("note_id", "=", noteId)
      .where("revision", "=", note.current_revision)
      .executeTakeFirst();
    return {
      id: note.id,
      title: note.title,
      summary: note.summary,
      kind: revision?.kind ?? null,
      current_revision: note.current_revision,
      body: (revision?.body_md ?? "").slice(0, 4000),
    };
  }
}
