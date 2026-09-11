import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
import type { Settings } from "../domain/settings.js";
import { ForgeError } from "../domain/errors.js";
import { resolveVaultRelative } from "./paths.js";
import { MemoryIndexService } from "./index.js";
import { MemoryService } from "./service.js";
import { invalidateDerivedForNote } from "./invalidation.js";

/**
 * Issue #41 (M08): bounded retention, explicit forgetting and restore
 * reconciliation.
 *
 * Hard rules encoded here:
 *  - canonical notes and accepted revisions are never deleted by retention;
 *    only an explicit authorized `purgeNote` removes them, and it leaves a
 *    durable `memory_purges` receipt that survives backup/restore.
 *  - pending events, pending spool rows and unreviewed candidates are never
 *    pruned; only terminal records past their window are.
 *  - retention windows are operator settings; active decisions, tasks and
 *    pins are untouched regardless of age.
 */

export const MAX_DELETES_PER_RUN = 5000;
export const MAX_EXTRACTION_PRUNE = 500;

export interface RetentionWindows {
  historyDays: number;
  captureDays: number;
  deliveryDays: number;
  diagnosticDays: number;
  backupDays: number;
}

export function retentionWindows(
  settings: Required<Settings>,
): RetentionWindows {
  return {
    historyDays: settings.memoryHistoryRetentionDays,
    captureDays: settings.memoryCaptureRetentionDays,
    deliveryDays: settings.memoryDeliveryRetentionDays,
    diagnosticDays: settings.memoryDiagnosticRetentionDays,
    backupDays: settings.memoryBackupRetentionDays,
  };
}

export interface RetentionReport {
  events_deleted: number;
  candidates_deleted: number;
  extractions_deleted: number;
  spool_deleted: number;
  flags_deleted: number;
  events_pending_kept: number;
  candidates_open_kept: number;
  notes_touched: 0;
  windows: RetentionWindows;
}

export class MemoryRetentionService {
  constructor(
    readonly deps: {
      db: Kysely<DB>;
      vaultRoot?: string;
      settings: Required<Settings>;
      now?: () => number;
    },
  ) {}

  private get db(): Kysely<DB> {
    return this.deps.db;
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One bounded retention pass; counts only, never note content. */
  async run(): Promise<RetentionReport> {
    const now = this.now;
    const windows = retentionWindows(this.deps.settings);
    const day = 86_400_000;
    const report: RetentionReport = {
      events_deleted: 0,
      candidates_deleted: 0,
      extractions_deleted: 0,
      spool_deleted: 0,
      flags_deleted: 0,
      events_pending_kept: 0,
      candidates_open_kept: 0,
      notes_touched: 0,
      windows,
    };
    // Delivery/idempotency records: terminal only.
    const events = await this.db
      .deleteFrom("memory_events")
      .where("state", "in", ["committed", "rejected"])
      .where("updated_at", "<", now - windows.deliveryDays * day)
      .executeTakeFirst();
    report.events_deleted = Number(events.numDeletedRows ?? 0);
    const pending = await this.db
      .selectFrom("memory_events")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("state", "=", "pending")
      .executeTakeFirstOrThrow();
    report.events_pending_kept = Number(pending.n);

    // Resolved source candidates: diagnostics only.
    const candidates = await this.db
      .deleteFrom("memory_change_candidates")
      .where("state", "in", ["applied", "rejected", "quarantined"])
      .where("updated_at", "<", now - windows.diagnosticDays * day)
      .executeTakeFirst();
    report.candidates_deleted = Number(candidates.numDeletedRows ?? 0);
    const openCandidates = await this.db
      .selectFrom("memory_change_candidates")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("state", "in", ["candidate", "conflict"])
      .executeTakeFirstOrThrow();
    report.candidates_open_kept = Number(openCandidates.n);

    // Old extraction records are diagnostics; keep the newest per key so the
    // model-cost cache still answers unchanged sources.
    const staleExtractions = await this.db
      .selectFrom("memory_curator_extractions as x")
      .select(["x.id"])
      .where("x.created_at", "<", now - windows.diagnosticDays * day)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("memory_curator_extractions as y")
            .select("y.id")
            .whereRef("y.tenant_id", "=", "x.tenant_id")
            .whereRef("y.space_id", "=", "x.space_id")
            .whereRef("y.extractor_version", "=", "x.extractor_version")
            .whereRef("y.policy_version", "=", "x.policy_version")
            .whereRef("y.source_fingerprint", "=", "x.source_fingerprint")
            .whereRef("y.mode", "=", "x.mode")
            .whereRef("y.created_at", ">", "x.created_at"),
        ),
      )
      .limit(MAX_EXTRACTION_PRUNE)
      .execute();
    if (staleExtractions.length > 0) {
      const deleted = await this.db
        .deleteFrom("memory_curator_extractions")
        .where(
          "id",
          "in",
          staleExtractions.map((row) => row.id),
        )
        .executeTakeFirst();
      report.extractions_deleted = Number(deleted.numDeletedRows ?? 0);
    }

    // Local capture spool: terminal rows only; pending rows are never pruned.
    const spool = await this.db
      .deleteFrom("memory_spool")
      .where("state", "in", ["delivered", "rejected", "conflict"])
      .where("updated_at", "<", now - windows.captureDays * day)
      .executeTakeFirst();
    report.spool_deleted = Number(spool.numDeletedRows ?? 0);
    const flags = await this.db
      .deleteFrom("memory_turn_flags")
      .where("expires_at", "<", now)
      .executeTakeFirst();
    report.flags_deleted = Number(flags.numDeletedRows ?? 0);

    await this.db
      .insertInto("memory_retention_runs")
      .values({
        id: randomUUID(),
        started_at: now,
        finished_at: this.now,
        report_json: JSON.stringify(report),
      })
      .execute();
    return report;
  }

  /**
   * Explicit authorized forgetting. The note must already be tombstoned or
   * the caller must be authorized for the space; rows, revision files and
   * derived index entries are removed, and a durable purge receipt remains so
   * replay/restore cannot revive it.
   */
  async purgeNote(
    identity: Identity,
    input: { spaceId: string; noteId: string; reason: string },
  ): Promise<{
    status: "purged" | "already_purged";
    note_id: string;
    purged_at: number;
    files_deleted: number;
  }> {
    const service = new MemoryService(this.db, undefined, this.deps.vaultRoot);
    await service.authorizeSpace(identity, input.spaceId, "write");
    const purgeId = {
      tenant_id: identity.tenantId,
      space_id: input.spaceId,
      note_id: input.noteId,
    };
    const existing = await this.db
      .selectFrom("memory_purges")
      .select(["purged_at"])
      .where("tenant_id", "=", purgeId.tenant_id)
      .where("space_id", "=", purgeId.space_id)
      .where("note_id", "=", purgeId.note_id)
      .executeTakeFirst();
    const note = await this.db
      .selectFrom("memory_notes")
      .select(["id"])
      .where("tenant_id", "=", purgeId.tenant_id)
      .where("space_id", "=", purgeId.space_id)
      .where("id", "=", purgeId.note_id)
      .executeTakeFirst();
    if (!note && existing)
      return {
        status: "already_purged",
        note_id: input.noteId,
        purged_at: existing.purged_at,
        files_deleted: 0,
      };
    if (!note)
      throw new ForgeError("memory_note_unavailable", "Not bulunamadı.", 404);
    const revisions = await this.db
      .selectFrom("memory_note_revisions")
      .select(["file_path"])
      .where("tenant_id", "=", purgeId.tenant_id)
      .where("space_id", "=", purgeId.space_id)
      .where("note_id", "=", purgeId.note_id)
      .execute();
    let filesDeleted = 0;
    if (this.deps.vaultRoot)
      for (const revision of revisions) {
        if (!revision.file_path) continue;
        try {
          await unlink(
            resolveVaultRelative(this.deps.vaultRoot, revision.file_path),
          );
          filesDeleted += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    const purgedAt = this.now;
    await this.db.transaction().execute(async (tx) => {
      await invalidateDerivedForNote(tx, purgeId);
      await tx
        .deleteFrom("memory_change_candidates")
        .where("tenant_id", "=", purgeId.tenant_id)
        .where("note_id", "=", purgeId.note_id)
        .execute();
      await tx
        .deleteFrom("memory_events")
        .where("tenant_id", "=", purgeId.tenant_id)
        .where("note_id", "=", purgeId.note_id)
        .execute();
      await tx
        .deleteFrom("memory_note_revisions")
        .where("tenant_id", "=", purgeId.tenant_id)
        .where("space_id", "=", purgeId.space_id)
        .where("note_id", "=", purgeId.note_id)
        .execute();
      await tx
        .deleteFrom("memory_notes")
        .where("tenant_id", "=", purgeId.tenant_id)
        .where("space_id", "=", purgeId.space_id)
        .where("id", "=", purgeId.note_id)
        .execute();
      await tx
        .insertInto("memory_purges")
        .values({
          ...purgeId,
          purged_at: purgedAt,
          reason: input.reason.slice(0, 500),
          source: "manual",
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: identity.tenantId,
          id: randomUUID(),
          user_id: identity.userId,
          project_id: null,
          kind: "memory.note.purged",
          detail: JSON.stringify({
            space_id: purgeId.space_id,
            note_id: purgeId.note_id,
            files_deleted: filesDeleted,
          }),
          created_at: purgedAt,
        })
        .execute();
    });
    return {
      status: "purged",
      note_id: input.noteId,
      purged_at: purgedAt,
      files_deleted: filesDeleted,
    };
  }

  async restoreStatus(): Promise<{
    reconciliation_required: boolean;
    last_receipt: {
      id: string;
      backend: string;
      purges_included: boolean;
      purges_applied: number;
      reconciled_at: number | null;
      created_at: number;
    } | null;
  }> {
    const last = await this.db
      .selectFrom("memory_restore_receipts")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return {
      reconciliation_required: Boolean(
        last && last.purges_included === 0 && last.reconciled_at === null,
      ),
      last_receipt: last
        ? {
            id: last.id,
            backend: last.backend,
            purges_included: last.purges_included === 1,
            purges_applied: last.purges_applied,
            reconciled_at: last.reconciled_at,
            created_at: last.created_at,
          }
        : null,
    };
  }

  async reconcileRestore(receiptId?: string): Promise<{ reconciled: number }> {
    const now = this.now;
    let query = this.db
      .updateTable("memory_restore_receipts")
      .set({ reconciled_at: now })
      .where("purges_included", "=", 0)
      .where("reconciled_at", "is", null);
    if (receiptId) query = query.where("id", "=", receiptId);
    const result = await query.executeTakeFirst();
    return { reconciled: Number(result.numUpdatedRows ?? 0) };
  }
}

/**
 * System re-index after a restore: derived search/graph/context is rebuilt
 * from the accepted revisions. Bounded pages, one tenant at a time.
 */
export async function rebuildDerivedAfterRestore(
  db: Kysely<DB>,
  vaultRoot: string,
): Promise<{ indexed: number; tenants: number }> {
  const memberships = await db
    .selectFrom("memberships")
    .select(["tenant_id", "user_id", "role"])
    .where("role", "in", ["founder", "admin"])
    .execute();
  const byTenant = new Map<string, string>();
  for (const membership of memberships)
    if (!byTenant.has(membership.tenant_id))
      byTenant.set(membership.tenant_id, membership.user_id);
  const index = new MemoryIndexService(
    db,
    vaultRoot,
    new MemoryService(db, undefined, vaultRoot),
  );
  let indexed = 0;
  for (const [tenantId, userId] of byTenant) {
    const identity: Identity = { tenantId, userId };
    let after: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const report = await index.rebuild(identity, {
        after,
        batchSize: 500,
      });
      indexed += report.indexed;
      if (!report.next) break;
      after = report.next;
    }
  }
  return { indexed, tenants: byTenant.size };
}

/** Persists the purge section of a backup manifest on restore. */
export async function applyPurgesFromBackup(
  db: Kysely<DB>,
  purges: readonly {
    tenant_id: string;
    space_id: string;
    note_id: string;
    purged_at: number;
    reason: string;
  }[],
): Promise<number> {
  let applied = 0;
  for (const purge of purges.slice(0, 100000)) {
    if (
      typeof purge?.tenant_id !== "string" ||
      typeof purge?.space_id !== "string" ||
      typeof purge?.note_id !== "string" ||
      typeof purge?.purged_at !== "number"
    )
      continue;
    const existing = await db
      .selectFrom("memory_purges")
      .select(["note_id"])
      .where("tenant_id", "=", purge.tenant_id)
      .where("space_id", "=", purge.space_id)
      .where("note_id", "=", purge.note_id)
      .executeTakeFirst();
    if (existing) continue;
    await db
      .insertInto("memory_purges")
      .values({
        tenant_id: purge.tenant_id.slice(0, 200),
        space_id: purge.space_id.slice(0, 200),
        note_id: purge.note_id.slice(0, 200),
        purged_at: purge.purged_at,
        reason: (purge.reason ?? "restored").slice(0, 500),
        source: "backup",
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    applied += 1;
  }
  return applied;
}

export async function recordRestoreReceipt(
  db: Kysely<DB>,
  input: {
    backend: string;
    manifestCreatedAt: string | null;
    purgesIncluded: boolean;
    purgesApplied: number;
  },
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("memory_restore_receipts")
    .values({
      id,
      backend: input.backend,
      manifest_created_at: input.manifestCreatedAt,
      purges_included: input.purgesIncluded ? 1 : 0,
      purges_applied: input.purgesApplied,
      reconciled_at: null,
      created_at: Date.now(),
    })
    .execute();
  return id;
}
