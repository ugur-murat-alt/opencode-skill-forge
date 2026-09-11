import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB, MemoryEvent, MemorySpace } from "../storage/schema.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
import type { MemorySpaceScope } from "../domain/memory.js";

/**
 * Issue #34 (M01): the single owner of memory application behavior. Spaces
 * carry an explicit typed scope and every read/write re-resolves the actor's
 * ACL from identity/membership rows; a note's or event's content can never
 * grant authority. Import/move/link/search/context belong to later issues and
 * must call this service instead of re-implementing policy. The first
 * version never creates automatic cross-space links or copies.
 */

export type MemoryAccess = "read" | "write";

export interface RecordMemoryEventInput {
  spaceId: string;
  sourceEventKey: string;
  sourceKind: string;
  /** SHA-256 hex of the redacted payload; the payload itself is not stored. */
  contentHash: string;
  observedAt?: number;
}

export interface MemoryEventResult {
  status: "recorded" | "duplicate";
  event: MemoryEvent;
}

export interface ReconcileReport {
  /** Events inspected in this bounded pass. */
  checked: number;
  pending: number;
  committed: number;
  rejected: number;
  /** Same source key seen with a different content hash (must stay 0). */
  conflicts: number;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class MemoryService {
  constructor(
    readonly db: Kysely<DB>,
    readonly identities: IdentityService = new IdentityService(db),
  ) {}

  /** The caller's personal space, created on first use by a writable member. */
  async ensureSpace(identity: Identity, scope: MemorySpaceScope) {
    if (scope.type === "personal") return this.ensurePersonal(identity);
    if (scope.type === "project")
      return this.ensureProject(identity, scope.projectId);
    throw new ForgeError(
      "invalid_scope",
      "Organizasyon alanı adıyla açıkça oluşturulur.",
      422,
    );
  }

  private async ensurePersonal(identity: Identity) {
    await this.identities.authorize(identity, "read");
    const existing = await this.findSpace(identity.tenantId, {
      kind: "personal",
      ownerUserId: identity.userId,
    });
    if (existing) return existing;
    await this.identities.authorize(identity, "write");
    return this.insertSpace(identity, {
      kind: "personal",
      owner_user_id: identity.userId,
      project_id: null,
      name: "Kişisel hafıza",
    });
  }

  private async ensureProject(identity: Identity, projectId: string) {
    await this.identities.authorize(identity, "read", projectId);
    const existing = await this.findSpace(identity.tenantId, {
      kind: "project",
      projectId,
    });
    if (existing) return existing;
    await this.identities.authorize(identity, "write", projectId);
    const project = await this.db
      .selectFrom("projects")
      .select(["name"])
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", projectId)
      .executeTakeFirstOrThrow();
    return this.insertSpace(identity, {
      kind: "project",
      owner_user_id: identity.userId,
      project_id: projectId,
      name: project.name,
    });
  }

  private findSpace(
    tenantId: string,
    scope:
      | { kind: "personal"; ownerUserId: string }
      | { kind: "project"; projectId: string },
  ) {
    const query = this.db
      .selectFrom("memory_spaces")
      .selectAll()
      .where("tenant_id", "=", tenantId);
    return scope.kind === "personal"
      ? query
          .where("kind", "=", "personal")
          .where("owner_user_id", "=", scope.ownerUserId)
          .executeTakeFirst()
      : query
          .where("kind", "=", "project")
          .where("project_id", "=", scope.projectId)
          .executeTakeFirst();
  }

  /**
   * Explicitly create a tenant-wide organization space. Tenant-level write
   * permission is required (reader/auditor excluded, frozen tenant closed);
   * the name is a label, not an identity, so duplicate names stay distinct
   * spaces.
   */
  async createOrganizationSpace(identity: Identity, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200)
      throw new ForgeError(
        "invalid_memory_space",
        "Alan adı 1–200 karakter olmalıdır.",
        422,
      );
    await this.identities.authorize(identity, "write");
    return this.insertSpace(identity, {
      kind: "organization",
      owner_user_id: identity.userId,
      project_id: null,
      name: trimmed,
    });
  }

  private async insertSpace(
    identity: Identity,
    values: Pick<MemorySpace, "kind" | "owner_user_id" | "project_id" | "name">,
  ) {
    const now = Date.now();
    const space: MemorySpace = {
      tenant_id: identity.tenantId,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      ...values,
    };
    try {
      return await this.db
        .insertInto("memory_spaces")
        .values(space)
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      // Concurrent creators race the partial unique indexes. The statement
      // ran outside any caller transaction precisely so the loser can read
      // the winner's row on both SQLite and PostgreSQL.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findSpace(
        identity.tenantId,
        space.kind === "personal"
          ? { kind: "personal", ownerUserId: space.owner_user_id }
          : { kind: "project", projectId: space.project_id! },
      );
      if (existing) return existing;
      throw error;
    }
  }

  /**
   * Resolve the space inside the caller's tenant and re-check the ACL from
   * identity rows. Personal: owner only. Project: project membership/role.
   * Organization: tenant membership (write excludes reader/auditor). A space
   * of another tenant is indistinguishable from a missing one.
   */
  async authorizeSpace(
    identity: Identity,
    spaceId: string,
    access: MemoryAccess,
  ): Promise<MemorySpace> {
    const space = await this.db
      .selectFrom("memory_spaces")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", spaceId)
      .executeTakeFirst();
    if (!space)
      throw new ForgeError(
        "memory_space_unavailable",
        "Hafıza alanı bulunamadı veya yetkiniz yok.",
        404,
      );
    if (space.kind === "personal") {
      await this.identities.authorize(identity, "read");
      if (space.owner_user_id !== identity.userId)
        throw new ForgeError(
          "forbidden",
          "Bu kişisel hafıza alanı başka bir kullanıcıya ait.",
          403,
        );
      if (access === "write")
        await this.identities.authorize(identity, "write");
      return space;
    }
    if (space.kind === "project") {
      if (!space.project_id)
        throw new ForgeError(
          "memory_space_unavailable",
          "Proje alanı tutarsız.",
          404,
        );
      await this.identities.authorize(identity, access, space.project_id);
      return space;
    }
    await this.identities.authorize(identity, access);
    return space;
  }

  /**
   * Durable, idempotent event acceptance. The same source key with the same
   * content hash is a duplicate; the same key with a different hash is a
   * conflict and is rejected with 409. No model and no payload body: only the
   * redacted content hash is stored.
   */
  async recordEvent(
    identity: Identity,
    input: RecordMemoryEventInput,
  ): Promise<MemoryEventResult> {
    if (
      !input.spaceId ||
      input.spaceId.length > 200 ||
      !input.sourceEventKey ||
      input.sourceEventKey.length > 200 ||
      !input.sourceKind ||
      input.sourceKind.length > 40 ||
      !HASH_PATTERN.test(input.contentHash) ||
      (input.observedAt !== undefined &&
        (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0))
    )
      throw new ForgeError(
        "invalid_memory_event",
        "Kaynak olay sözleşmesi geçersiz.",
        422,
      );
    return this.db.transaction().execute(async (tx) => {
      const service = new MemoryService(tx);
      await service.authorizeSpace(identity, input.spaceId, "write");
      const existing = await tx
        .selectFrom("memory_events")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "=", input.spaceId)
        .where("source_event_key", "=", input.sourceEventKey)
        .executeTakeFirst();
      if (existing)
        return service.duplicateOrThrow(existing, input.contentHash);
      const now = Date.now();
      const event: MemoryEvent = {
        tenant_id: identity.tenantId,
        space_id: input.spaceId,
        id: randomUUID(),
        source_event_key: input.sourceEventKey,
        source_kind: input.sourceKind,
        content_hash: input.contentHash,
        state: "pending",
        observed_at: input.observedAt ?? null,
        created_at: now,
        updated_at: now,
        committed_revision: null,
      };
      const inserted = await tx
        .insertInto("memory_events")
        .values(event)
        .onConflict((oc) =>
          oc.columns(["tenant_id", "space_id", "source_event_key"]).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      if (inserted) return { status: "recorded" as const, event: inserted };
      const raced = await tx
        .selectFrom("memory_events")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "=", input.spaceId)
        .where("source_event_key", "=", input.sourceEventKey)
        .executeTakeFirst();
      if (!raced)
        throw new ForgeError(
          "memory_event_unavailable",
          "Kaynak olayı kaydedilemedi.",
          409,
        );
      return service.duplicateOrThrow(raced, input.contentHash);
    });
  }

  private duplicateOrThrow(
    existing: MemoryEvent,
    contentHash: string,
  ): MemoryEventResult {
    if (existing.content_hash !== contentHash)
      throw new ForgeError(
        "memory_event_conflict",
        "Aynı kaynak anahtarı farklı içerikle daha önce kaydedildi.",
        409,
      );
    return { status: "duplicate", event: existing };
  }

  /**
   * Deterministic, bounded, model-free reconciliation report. Only spaces the
   * actor may read are inspected; no note is created, mutated or deleted and
   * no cross-space link is produced. Counts are the real inspected rows.
   */
  async reconcile(
    identity: Identity,
    input: { spaceId?: string; limit?: number } = {},
  ): Promise<ReconcileReport> {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ForgeError(
        "invalid_memory_reconcile",
        "Uzlaştırma limiti 1–100 olmalıdır.",
        422,
      );
    return this.db.transaction().execute(async (tx) => {
      const service = new MemoryService(tx);
      let spaceIds: string[];
      if (input.spaceId) {
        const space = await service.authorizeSpace(
          identity,
          input.spaceId,
          "read",
        );
        spaceIds = [space.id];
      } else {
        const role = await service.identities.authorize(identity, "read");
        const administrator = role === "founder" || role === "admin";
        const rows = await tx
          .selectFrom("memory_spaces")
          .select(["id"])
          .where("tenant_id", "=", identity.tenantId)
          .where((eb) =>
            eb.or([
              eb.and([
                eb("kind", "=", "personal"),
                eb("owner_user_id", "=", identity.userId),
              ]),
              eb("kind", "=", "organization"),
              eb.and([
                eb("kind", "=", "project"),
                administrator
                  ? eb("project_id", "is not", null)
                  : eb("project_id", "in", (sub) =>
                      sub
                        .selectFrom("project_members")
                        .select("project_id")
                        .where("tenant_id", "=", identity.tenantId)
                        .where("user_id", "=", identity.userId),
                    ),
              ]),
            ]),
          )
          .execute();
        spaceIds = rows.map((row) => row.id);
      }
      if (spaceIds.length === 0)
        return {
          checked: 0,
          pending: 0,
          committed: 0,
          rejected: 0,
          conflicts: 0,
        };
      const events = await tx
        .selectFrom("memory_events")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("space_id", "in", spaceIds)
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      const report: ReconcileReport = {
        checked: events.length,
        pending: 0,
        committed: 0,
        rejected: 0,
        conflicts: 0,
      };
      const seen = new Map<string, string>();
      for (const event of events) {
        if (event.state === "pending") report.pending += 1;
        else if (event.state === "committed") report.committed += 1;
        else if (event.state === "rejected") report.rejected += 1;
        const key = `${event.space_id}\u0000${event.source_event_key}`;
        const previous = seen.get(key);
        if (previous === undefined) seen.set(key, event.content_hash);
        else if (previous !== event.content_hash) report.conflicts += 1;
      }
      return report;
    });
  }
}

/** Unique-violation detection across SQLite and PostgreSQL drivers. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed/i.test(message);
}
