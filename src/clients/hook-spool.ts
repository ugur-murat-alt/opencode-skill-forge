import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { openDatabase, openDatabaseConnection } from "../storage/database.js";
import type { DB, MemorySpoolRow } from "../storage/schema.js";
import { sanitizeUntrustedText } from "../telemetry/sanitize.js";
import type { LocalConfig } from "../cli/config.js";
import { isUniqueViolation } from "../memory/service.js";
import {
  HOOK_SPOOL_PROTOCOL_VERSION,
  type ClientName,
} from "./hook-contract.js";

/**
 * Issue #38 (M05) Faz A: the local durable hook spool.
 *
 * Protocol:
 *  - `acceptHookCapture` durably (fsync through SQLite) stores one redacted
 *    checkpoint and returns. It never talks to the daemon and never claims a
 *    durable memory commit; that is the M02 receipt's job.
 *  - `deliverSpool` resolves the project's memory space, then delivers pending
 *    rows to `POST /api/memory/ingest` idempotently. The same `event_id`
 *    (source event key) always maps to one accepted event; a duplicate
 *    delivery returns the same receipt.
 *  - The spool is bounded. Pending rows are never deleted silently: when the
 *    queue is full, new capture is rejected with a visible counter, and a
 *    failed accept never reports `accepted`.
 *
 * Nothing here reads `transcript_path`; no token, pairing code or raw private
 * reasoning is stored. `last_error` holds short diagnostic codes only.
 */

export const HOOK_SPOOL_LIMITS = Object.freeze({
  /** Maximum pending (not yet delivered) rows across all installations. */
  maxPendingRows: 500,
  /** One redacted checkpoint stays below the M02 content limit. */
  maxContentBytes: 48 * 1024,
  /** Terminal rows are pruned after this age; pending rows are kept. */
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  /** After this many failed delivery attempts a row becomes terminal. */
  maxAttempts: 12,
  maxRowsPerDelivery: 25,
  defaultDeliveryBudgetMs: 1500,
  perRequestTimeoutMs: 700,
  flagTtlMs: 30 * 60 * 1000,
});

export type SpoolCounterKey =
  | "spool_full"
  | "content_limit"
  | "event_conflict"
  | "unsupported_event"
  | "ingest_rejected"
  | "delivery_attempt_limit"
  | "turn_flag_error"
  | "binding_mismatch"
  | "project_root_missing"
  | "capture_error";

export interface WithSpoolDbOptions {
  /** Local data directory; the spool stays local even for server profiles. */
  dataDir: string;
}

/** Opens the local database and always closes it. */
export async function withSpoolDb<T>(
  dataDir: string,
  fn: (db: Kysely<DB>) => Promise<T>,
): Promise<T> {
  // Hot path: open the driver directly and verify the spool table. Migrations
  // normally ran at install/daemon start; only a missing table pays for the
  // full migrator, so a hook event does not re-check every migration.
  const handle = await openDatabaseConnection({ dataDir });
  let ready = true;
  try {
    await handle.db.selectFrom("memory_spool").select("id").limit(1).execute();
  } catch {
    ready = false;
  }
  if (ready) {
    try {
      return await fn(handle.db);
    } finally {
      await handle.close();
    }
  }
  await handle.close();
  const storage = await openDatabase({ dataDir });
  try {
    return await fn(storage.db);
  } finally {
    await storage.close();
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function bumpCounter(
  db: Kysely<DB>,
  key: SpoolCounterKey,
  now: number,
): Promise<void> {
  await db
    .insertInto("memory_spool_counters")
    .values({ key, value: 1, updated_at: now })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet({
        value: sql<number>`memory_spool_counters.value + 1`,
        updated_at: now,
      }),
    )
    .execute();
}

async function bumpCounterSafe(dataDir: string, key: SpoolCounterKey) {
  try {
    await withSpoolDb(dataDir, (db) => bumpCounter(db, key, Date.now()));
  } catch {
    // Diagnostics must never fail the client hook.
  }
}

/** Records an unsupported/ignored event shape without a success claim. */
export async function recordUnsupportedEvent(dataDir: string): Promise<void> {
  await bumpCounterSafe(dataDir, "unsupported_event");
}

/** Best-effort visible counter for capture-path failures (code only). */
export async function recordSpoolCounter(
  dataDir: string,
  key: SpoolCounterKey,
): Promise<void> {
  await bumpCounterSafe(dataDir, key);
}

export interface HookCaptureInput {
  dataDir: string;
  /** Canonical install identity: fingerprint([client, projectRoot]). */
  installationId: string;
  projectRef: string;
  client: ClientName;
  event: string;
  /** Caller validated: non-empty, bounded, never "unknown". */
  sessionId: string;
  turnRef: string | null;
  worktreeKey: string | null;
  sourceKind: string;
  /** Memory kind used when the ingest commits a note. */
  kind: string;
  /** Visible final summary (already bounded by the caller). */
  content: string;
  observedAt?: number;
  now?: number;
}

export type HookCaptureStatus =
  "accepted" | "duplicate" | "conflict" | "rejected";

export interface HookCaptureResult {
  status: HookCaptureStatus;
  id?: string;
  reason?: string;
}

/**
 * Deterministic event identity. A retry of the same logical event produces the
 * same id; the same id with different content is a conflict, never an update.
 */
export function hookEventId(input: {
  installationId: string;
  projectRef: string;
  client: ClientName;
  event: string;
  sessionId: string;
  turnRef: string | null;
  worktreeKey: string | null;
  contentHash: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      HOOK_SPOOL_PROTOCOL_VERSION,
      input.installationId,
      input.projectRef,
      input.client,
      input.event,
      input.sessionId,
      input.turnRef,
      input.worktreeKey,
      input.contentHash,
    ]),
  );
}

export async function acceptHookCapture(
  input: HookCaptureInput,
): Promise<HookCaptureResult> {
  return withSpoolDb(input.dataDir, (db) =>
    acceptHookCaptureInDb(db, input, input.now ?? Date.now()),
  );
}

export async function acceptHookCaptureInDb(
  db: Kysely<DB>,
  input: HookCaptureInput,
  now: number,
): Promise<HookCaptureResult> {
  // Capture content is untrusted: redact before anything reaches disk.
  const content = sanitizeUntrustedText(
    input.content,
    HOOK_SPOOL_LIMITS.maxContentBytes,
  );
  if (!content.trim()) {
    await bumpCounter(db, "content_limit", now);
    return { status: "rejected", reason: "empty_content" };
  }
  const contentBytes = Buffer.byteLength(content);
  if (contentBytes > HOOK_SPOOL_LIMITS.maxContentBytes) {
    await bumpCounter(db, "content_limit", now);
    return { status: "rejected", reason: "content_limit" };
  }
  const contentHash = sha256Hex(content);
  const eventId = hookEventId({ ...input, contentHash });
  const pending = await db
    .selectFrom("memory_spool")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("state", "=", "pending")
    .executeTakeFirst();
  if (Number(pending?.count ?? 0) >= HOOK_SPOOL_LIMITS.maxPendingRows) {
    await bumpCounter(db, "spool_full", now);
    return { status: "rejected", reason: "spool_full" };
  }
  // Bounded storage: only terminal rows are pruned; pending rows are kept.
  await db
    .deleteFrom("memory_spool")
    .where("state", "in", ["delivered", "rejected", "conflict"])
    .where("updated_at", "<", now - HOOK_SPOOL_LIMITS.retentionMs)
    .execute();
  try {
    const id = randomUUID();
    await db
      .insertInto("memory_spool")
      .values({
        id,
        installation_id: input.installationId,
        project_ref: input.projectRef,
        client: input.client,
        event: input.event,
        session_id: input.sessionId,
        turn_ref: input.turnRef,
        worktree_key: input.worktreeKey,
        event_id: eventId,
        source_kind: input.sourceKind,
        kind: input.kind,
        content,
        content_hash: contentHash,
        content_bytes: contentBytes,
        state: "pending",
        attempts: 0,
        next_attempt_at: 0,
        run_id: null,
        last_error: null,
        observed_at: input.observedAt ?? now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return { status: "accepted", id };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db
      .selectFrom("memory_spool")
      .select(["id", "content_hash"])
      .where("installation_id", "=", input.installationId)
      .where("event_id", "=", eventId)
      .executeTakeFirst();
    if (existing && existing.content_hash === contentHash)
      return { status: "duplicate", id: existing.id };
    await bumpCounter(db, "event_conflict", now);
    return { status: "conflict", reason: "event_conflict" };
  }
}

export interface TurnFlagInput {
  dataDir: string;
  installationId: string;
  sessionId: string;
  turnRef: string | null;
  now?: number;
}

/**
 * Records the turn-scoped `[memory:off]` decision. Every prompt writes the
 * flag (off=false when the marker is absent), so a stale value cannot leak
 * into the next turn.
 */
export async function setTurnMemoryOff(
  input: TurnFlagInput & { memoryOff: boolean },
): Promise<void> {
  await withSpoolDb(input.dataDir, (db) =>
    setTurnMemoryOffInDb(db, input, input.now ?? Date.now()),
  );
}

export async function setTurnMemoryOffInDb(
  db: Kysely<DB>,
  input: TurnFlagInput & { memoryOff: boolean },
  now: number,
): Promise<void> {
  await db
    .insertInto("memory_turn_flags")
    .values({
      installation_id: input.installationId,
      session_id: input.sessionId,
      turn_ref: input.turnRef,
      memory_off: input.memoryOff ? 1 : 0,
      created_at: now,
      expires_at: now + HOOK_SPOOL_LIMITS.flagTtlMs,
    })
    .onConflict((oc) =>
      oc.columns(["installation_id", "session_id"]).doUpdateSet({
        turn_ref: input.turnRef,
        memory_off: input.memoryOff ? 1 : 0,
        created_at: now,
        expires_at: now + HOOK_SPOOL_LIMITS.flagTtlMs,
      }),
    )
    .execute();
  // Opportunistic cleanup of expired flags of other sessions.
  await db
    .deleteFrom("memory_turn_flags")
    .where("expires_at", "<", now)
    .execute();
}

/**
 * Stop consumes the flag: `true` means this whole turn is memory-off, so both
 * context injection and capture stay disabled and the flag does not leak into
 * the next turn.
 */
export async function consumeTurnMemoryOff(
  input: TurnFlagInput,
): Promise<boolean> {
  const now = input.now ?? Date.now();
  return withSpoolDb(input.dataDir, async (db) => {
    const row = await db
      .selectFrom("memory_turn_flags")
      .select(["memory_off", "expires_at"])
      .where("installation_id", "=", input.installationId)
      .where("session_id", "=", input.sessionId)
      .executeTakeFirst();
    if (!row) return false;
    await db
      .deleteFrom("memory_turn_flags")
      .where("installation_id", "=", input.installationId)
      .where("session_id", "=", input.sessionId)
      .execute();
    return row.memory_off === 1 && row.expires_at >= now;
  });
}

export interface DeliverSpoolOptions {
  config: Pick<LocalConfig, "dataDir" | "url" | "token">;
  fetchImpl?: typeof fetch;
  limit?: number;
  budgetMs?: number;
  now?: number;
}

export interface DeliverSpoolReport {
  attempted: number;
  delivered: number;
  duplicates: number;
  retried: number;
  rejected: number;
  conflicts: number;
  spaceUnavailable: number;
  errors: string[];
}

const SPACE_PAGE_LIMIT = 100;
const SPACE_MAX_PAGES = 3;

/**
 * Delivers pending rows to the M02 ingest endpoint. It is safe to call from a
 * short-lived hook process: bounded rows, bounded wall time, no model call.
 */
export async function deliverSpool(
  options: DeliverSpoolOptions,
): Promise<DeliverSpoolReport> {
  const now = options.now ?? Date.now();
  const budgetMs =
    options.budgetMs ?? HOOK_SPOOL_LIMITS.defaultDeliveryBudgetMs;
  const deadline = now + budgetMs;
  const limit = Math.min(
    options.limit ?? HOOK_SPOOL_LIMITS.maxRowsPerDelivery,
    HOOK_SPOOL_LIMITS.maxRowsPerDelivery,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const report: DeliverSpoolReport = {
    attempted: 0,
    delivered: 0,
    duplicates: 0,
    retried: 0,
    rejected: 0,
    conflicts: 0,
    spaceUnavailable: 0,
    errors: [],
  };
  const spaceCache = new Map<string, string | null>();
  await withSpoolDb(options.config.dataDir, async (db) => {
    const rows = await db
      .selectFrom("memory_spool")
      .selectAll()
      .where("state", "=", "pending")
      .where("next_attempt_at", "<=", now)
      .orderBy("created_at")
      .orderBy("id")
      .limit(limit)
      .execute();
    for (const row of rows) {
      if (Date.now() >= deadline) break;
      report.attempted += 1;
      try {
        let spaceId = spaceCache.get(row.project_ref);
        if (spaceId === undefined) {
          spaceId = await resolveProjectSpace(
            fetchImpl,
            options.config,
            row.project_ref,
            deadline,
          );
          spaceCache.set(row.project_ref, spaceId);
        }
        if (!spaceId) {
          report.spaceUnavailable += 1;
          await scheduleRetry(db, row, "space_unavailable", Date.now());
          continue;
        }
        const response = await fetchImpl(
          `${options.config.url}/api/memory/ingest`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.config.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              space_id: spaceId,
              source_event_key: `hook:${row.event_id}`,
              source_kind: row.source_kind,
              content: row.content,
              kind: row.kind,
            }),
            signal: AbortSignal.timeout(
              Math.min(
                HOOK_SPOOL_LIMITS.perRequestTimeoutMs,
                Math.max(1, deadline - Date.now()),
              ),
            ),
          },
        );
        if (response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            status?: unknown;
            run_id?: unknown;
          };
          if (body.status === "accepted" || body.status === "duplicate") {
            await markDelivered(db, row, body, Date.now());
            if (body.status === "duplicate") report.duplicates += 1;
            else report.delivered += 1;
            continue;
          }
          report.retried += 1;
          await scheduleRetry(db, row, "unexpected_response", Date.now());
          continue;
        }
        if (response.status === 409) {
          report.conflicts += 1;
          await markTerminal(
            db,
            row,
            "conflict",
            "idempotency_conflict",
            Date.now(),
          );
          continue;
        }
        if (response.status === 422) {
          report.rejected += 1;
          await markTerminal(
            db,
            row,
            "rejected",
            "ingest_rejected",
            Date.now(),
          );
          continue;
        }
        if (response.status === 404) {
          report.spaceUnavailable += 1;
          await scheduleRetry(db, row, "space_unavailable", Date.now());
          continue;
        }
        report.retried += 1;
        await scheduleRetry(db, row, `http_${response.status}`, Date.now());
      } catch (error) {
        const code = errorCode(error);
        report.retried += 1;
        if (report.errors.length < 10 && !report.errors.includes(code))
          report.errors.push(code);
        await scheduleRetry(db, row, code, Date.now()).catch(() => undefined);
      }
    }
  });
  return report;
}

async function resolveProjectSpace(
  fetchImpl: typeof fetch,
  config: Pick<LocalConfig, "url" | "token">,
  projectRef: string,
  deadline: number,
): Promise<string | null> {
  let after: string | null = null;
  for (let page = 0; page < SPACE_MAX_PAGES; page += 1) {
    const remaining = Math.max(1, deadline - Date.now());
    const query = new URLSearchParams({ limit: String(SPACE_PAGE_LIMIT) });
    if (after) query.set("after", after);
    const response = await fetchImpl(
      `${config.url}/api/memory/spaces?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(
          Math.min(HOOK_SPOOL_LIMITS.perRequestTimeoutMs, remaining),
        ),
      },
    );
    if (!response.ok) throw new Error(`spaces_http_${response.status}`);
    const body = (await response.json()) as {
      items?: Array<{ id?: unknown; kind?: unknown; project_id?: unknown }>;
      next?: unknown;
    };
    if (!Array.isArray(body.items)) throw new Error("spaces_unexpected_shape");
    const match = body.items.find(
      (item) => item.kind === "project" && item.project_id === projectRef,
    );
    if (match && typeof match.id === "string") return match.id;
    after = typeof body.next === "string" ? body.next : null;
    if (!after) return null;
  }
  return null;
}

async function markDelivered(
  db: Kysely<DB>,
  row: MemorySpoolRow,
  body: { run_id?: unknown },
  now: number,
): Promise<void> {
  await db
    .updateTable("memory_spool")
    .set({
      state: "delivered",
      content: "",
      content_bytes: 0,
      run_id: typeof body.run_id === "string" ? body.run_id : null,
      last_error: null,
      attempts: row.attempts + 1,
      updated_at: now,
    })
    .where("id", "=", row.id)
    .execute();
}

async function markTerminal(
  db: Kysely<DB>,
  row: MemorySpoolRow,
  state: "rejected" | "conflict",
  reason: string,
  now: number,
): Promise<void> {
  await db
    .updateTable("memory_spool")
    .set({
      state,
      content: "",
      content_bytes: 0,
      last_error: reason,
      attempts: row.attempts + 1,
      updated_at: now,
    })
    .where("id", "=", row.id)
    .execute();
  await bumpCounter(
    db,
    state === "conflict" ? "event_conflict" : "ingest_rejected",
    now,
  );
}

async function scheduleRetry(
  db: Kysely<DB>,
  row: MemorySpoolRow,
  reason: string,
  now: number,
): Promise<void> {
  const attempts = row.attempts + 1;
  if (attempts >= HOOK_SPOOL_LIMITS.maxAttempts) {
    await db
      .updateTable("memory_spool")
      .set({
        state: "rejected",
        content: "",
        content_bytes: 0,
        last_error: "delivery_attempt_limit",
        attempts,
        updated_at: now,
      })
      .where("id", "=", row.id)
      .execute();
    await bumpCounter(db, "delivery_attempt_limit", now);
    return;
  }
  const backoff = Math.min(1000 * 2 ** attempts, 60 * 60 * 1000);
  await db
    .updateTable("memory_spool")
    .set({
      attempts,
      next_attempt_at: now + backoff,
      last_error: reason.slice(0, 120),
      updated_at: now,
    })
    .where("id", "=", row.id)
    .execute();
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return `net_${code}`.slice(0, 120);
  if (error instanceof Error && error.message.startsWith("spaces_"))
    return error.message.slice(0, 120);
  return "network_error";
}

export interface SpoolDiagnostics {
  pending: number;
  delivered: number;
  rejected: number;
  conflicts: number;
  oldestPendingAt: number | null;
  lastError: string | null;
  counters: Record<string, number>;
  totalBytes: number;
}

/** Visible, content-free status for the diagnostics surface. */
export async function spoolDiagnostics(
  dataDir: string,
): Promise<SpoolDiagnostics> {
  return withSpoolDb(dataDir, async (db) => {
    const grouped = await db
      .selectFrom("memory_spool")
      .select(["state"])
      .select((eb) => eb.fn.countAll().as("count"))
      .groupBy("state")
      .execute();
    const byState = new Map(
      grouped.map((row) => [row.state, Number(row.count)]),
    );
    const pendingRow = await db
      .selectFrom("memory_spool")
      .select((eb) => eb.fn.min("created_at").as("oldest"))
      .where("state", "=", "pending")
      .executeTakeFirst();
    const lastErrorRow = await db
      .selectFrom("memory_spool")
      .select("last_error")
      .where("last_error", "is not", null)
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const bytesRow = await db
      .selectFrom("memory_spool")
      .select((eb) => eb.fn.sum("content_bytes").as("bytes"))
      .executeTakeFirst();
    const counters = await db
      .selectFrom("memory_spool_counters")
      .selectAll()
      .execute();
    return {
      pending: byState.get("pending") ?? 0,
      delivered: byState.get("delivered") ?? 0,
      rejected: byState.get("rejected") ?? 0,
      conflicts: byState.get("conflict") ?? 0,
      oldestPendingAt: pendingRow?.oldest ? Number(pendingRow.oldest) : null,
      lastError: lastErrorRow?.last_error ?? null,
      counters: Object.fromEntries(
        counters.map((row) => [row.key, Number(row.value)]),
      ),
      totalBytes: Number(bytesRow?.bytes ?? 0),
    };
  }).catch((): SpoolDiagnostics => ({
    pending: 0,
    delivered: 0,
    rejected: 0,
    conflicts: 0,
    oldestPendingAt: null,
    lastError: null,
    counters: {},
    totalBytes: 0,
  }));
}
