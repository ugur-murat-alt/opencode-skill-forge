import type { Settings } from "../domain/settings.js";
import { randomUUID, createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB, Run, RunState } from "../storage/schema.js";
import type { DatabaseHandle } from "../storage/database.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { SettingsService } from "../application/settings.js";
import { ForgeError } from "../domain/errors.js";
import {
  defaultJobKinds,
  type DefaultJobKind,
  type JobKindDefinition,
  type JobScope,
} from "../domain/job-kinds.js";
export type { JobScope } from "../domain/job-kinds.js";
export const terminalStates: RunState[] = [
  "completed",
  "no_op",
  "rejected",
  "failed",
  "cancelled",
  "superseded",
  "improved",
  "unchanged",
  "fallback",
];
/**
 * Issue #34: resolve the typed scope from the legacy `projectId` shorthand or
 * the explicit `scope`. Exactly one is required; no fake project is built.
 */
export function resolveJobScope(input: {
  projectId?: string;
  scope?: JobScope;
}): JobScope {
  if (input.projectId !== undefined && input.scope !== undefined)
    throw new ForgeError(
      "invalid_scope",
      "İş kapsamı projectId ve scope ile birlikte verilemez.",
      422,
    );
  if (input.scope !== undefined) {
    const scope = input.scope as { type?: unknown; projectId?: unknown };
    if (scope.type === "project") {
      if (typeof scope.projectId !== "string" || !scope.projectId)
        throw new ForgeError(
          "invalid_scope",
          "Proje kapsamı gerçek bir projectId gerektirir.",
          422,
        );
      return { type: "project", projectId: scope.projectId };
    }
    if (scope.type === "personal" || scope.type === "organization")
      return { type: scope.type };
    throw new ForgeError("invalid_scope", "Tanımsız iş kapsamı.", 422);
  }
  if (typeof input.projectId === "string" && input.projectId)
    return { type: "project", projectId: input.projectId };
  throw new ForgeError(
    "invalid_scope",
    "İş kapsamı (proje veya kişisel/organizasyon) zorunlu.",
    422,
  );
}
/** Stable idempotency/ACL key for a scope; never a fabricated project id. */
export function jobScopeKey(
  scope: JobScope,
  identity: { userId: string },
): string {
  if (scope.type === "project") return scope.projectId;
  if (scope.type === "personal") return identity.userId;
  return "organization";
}
/**
 * Issue #32: acceptance, scheduling, idempotency, budget and audit stay
 * common; kind-specific payload validation, config snapshot and skill-owned
 * gates come from the static `kinds` registry. `skill_evolve` remains the
 * default so existing `new JobQueue(storage)` callers keep their contract.
 */
export class JobQueue<Kind extends string = DefaultJobKind> {
  constructor(
    readonly storage: DatabaseHandle,
    readonly policy: Settings = {},
    readonly kinds: Readonly<
      Record<Kind, JobKindDefinition>
    > = defaultJobKinds as unknown as Readonly<Record<Kind, JobKindDefinition>>,
  ) {}
  async accept(
    identity: Identity,
    input: {
      /** Legacy project shorthand; exactly one of projectId/scope is required. */
      projectId?: string;
      /** Issue #34: explicit personal/project/organization target. */
      scope?: JobScope;
      kind: Kind;
      key: string;
      payload: Record<string, unknown>;
      deadlineMs?: number;
    },
  ) {
    const definition = this.kinds[input.kind];
    if (!definition)
      throw new ForgeError("invalid_kind", "Desteklenmeyen iş türü.");
    const scope = resolveJobScope(input);
    // Skill (and other project-owned) kinds keep their project requirement;
    // memory kinds accept explicit project/personal/organization scopes.
    const memoryKind = definition.scope === "memory";
    if (!memoryKind && scope.type !== "project")
      throw new ForgeError(
        "invalid_scope",
        "Bu iş türü proje kapsamı gerektirir.",
        422,
      );
    if (
      !input.key ||
      input.key.length > 200 ||
      Buffer.byteLength(JSON.stringify(input.payload)) > 65536
    )
      throw new ForgeError(
        "invalid_handoff",
        "İş kimliği veya girdi boyutu geçersiz.",
      );
    let payload: unknown;
    try {
      payload = definition.payload.parse(input.payload);
    } catch {
      throw new ForgeError(
        "invalid_handoff",
        "İş girdisi bu türün sözleşmesine uymuyor.",
        422,
        undefined,
        { kind: input.kind },
      );
    }
    const inputJson = JSON.stringify(payload);
    if (typeof inputJson !== "string" || Buffer.byteLength(inputJson) > 65536)
      throw new ForgeError("invalid_handoff", "İş girdisi serileştirilemedi.");
    const inputHash = createHash("sha256").update(inputJson).digest("hex");
    const scopeKey = jobScopeKey(scope, identity);
    return this.storage.db.transaction().execute(async (tx) => {
      // Serialize acceptance/budget/backpressure for this actor across processes.
      await tx
        .updateTable("memberships")
        .set({ role: sql`role` })
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .execute();
      const auth = new IdentityService(tx);
      // Project scope reuses the project run permission; personal and
      // organization scope only prove the tenant-level run permission here.
      // The concrete space ACL is verified by MemoryService inside the
      // handler and again at every later commit step (see ADR).
      if (scope.type === "project")
        await auth.authorize(identity, "run", scope.projectId);
      else await auth.authorize(identity, "run");
      const old = await tx
        .selectFrom("runs")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("scope_kind", "=", scope.type)
        .where("scope_key", "=", scopeKey)
        .where("kind", "=", input.kind)
        .where("idempotency_key", "=", input.key)
        .executeTakeFirst();
      if (old) {
        if (old.input_hash !== inputHash)
          throw new ForgeError(
            "idempotency_conflict",
            "Aynı idempotency anahtarı farklı girdiye ait.",
            409,
          );
        return { status: "duplicate" as const, run: old };
      }
      const effective = await new SettingsService(auth, this.policy).effective(
        identity,
        scope.type === "project" ? scope.projectId : undefined,
        {},
      );
      // Memory kinds are gated by the independent memoryEnabled flag; skill
      // kinds keep their own evolution gate below. The two never substitute
      // for each other.
      if (memoryKind && !effective.values.memoryEnabled)
        throw new ForgeError(
          "memory_disabled",
          "Hafıza bu kapsamda kapalı.",
          422,
        );
      // Skill-owned kinds alone read the provider snapshot and obey the
      // evolution flag; other kinds use the same effective policy without it.
      let config: Record<string, unknown> = { ...effective };
      if (definition.skillProfile) {
        const providerProfile = await tx
          .selectFrom("provider_profiles")
          .selectAll()
          .where("tenant_id", "=", identity.tenantId)
          .where("user_id", "=", identity.userId)
          .where("role", "=", "skill")
          .orderBy("revision", "desc")
          .limit(1)
          .executeTakeFirst();
        if (!effective.values.evolutionEnabled)
          throw new ForgeError(
            "evolution_disabled",
            "Skill geliştirme bu kapsamda kapalı.",
            422,
          );
        config = { ...effective, providerProfile: providerProfile ?? null };
      }
      const pending = await tx
        .selectFrom("runs")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("state", "not in", terminalStates)
        .executeTakeFirstOrThrow();
      if (Number(pending.n) >= 100)
        throw new ForgeError(
          "queue_full",
          "Bu kullanıcı için iş kuyruğu dolu.",
          429,
          5,
        );
      const now = await this.now(tx);
      const sessionId = randomUUID(),
        runId = randomUUID();
      await tx
        .insertInto("forge_sessions")
        .values({
          tenant_id: identity.tenantId,
          id: sessionId,
          user_id: identity.userId,
          project_id: scope.type === "project" ? scope.projectId : null,
          created_at: now,
        })
        .execute();
      const run: Run = {
        tenant_id: identity.tenantId,
        id: runId,
        session_id: sessionId,
        user_id: identity.userId,
        project_id: scope.type === "project" ? scope.projectId : null,
        scope_kind: scope.type,
        scope_key: scopeKey,
        kind: input.kind,
        state: "queued",
        idempotency_key: input.key,
        input_hash: inputHash,
        input_json: inputJson,
        config_json: JSON.stringify(config),
        result_json: null,
        error_code: null,
        created_at: now,
        updated_at: now,
        available_at: now,
        deadline_at:
          now + Math.max(100, Math.min(input.deadlineMs ?? 600000, 3600000)),
        lease_until: 0,
        worker_id: null,
        fence: 0,
        attempt: 0,
        max_attempts: 3,
      };
      await tx.insertInto("runs").values(run).execute();
      await this.audit(
        tx,
        run,
        "job.accepted",
        {
          run_id: runId,
          kind: input.kind,
          scope_kind: scope.type,
          scope_key: scopeKey,
        },
        now,
      );
      await tx
        .insertInto("outbox")
        .values({ tenant_id: identity.tenantId, run_id: runId, delivered: 0 })
        .execute();
      await tx
        .insertInto("queue_fairness")
        .values({
          tenant_id: identity.tenantId,
          user_id: identity.userId,
          last_claimed: 0,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();
      return { status: "accepted" as const, run };
    });
  }
  /** Issue #32: one audit wall entry for every kind, in the same transaction. */
  private async audit(
    db: Kysely<DB>,
    run: Pick<Run, "tenant_id" | "user_id" | "project_id" | "id" | "kind">,
    kind: string,
    detail: Record<string, unknown>,
    now: number,
  ) {
    await db
      .insertInto("audit_events")
      .values({
        tenant_id: run.tenant_id,
        id: randomUUID(),
        user_id: run.user_id,
        project_id: run.project_id,
        kind,
        detail: JSON.stringify(detail),
        created_at: now,
      })
      .execute();
  }
  private async now(db: Kysely<DB>) {
    const query =
      this.storage.backend === "postgres"
        ? sql<{
            now: number;
          }>`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now`
        : sql<{
            now: number;
          }>`select cast((julianday('now') - 2440587.5) * 86400000 as integer) as now`;
    return Number((await query.execute(db)).rows[0]!.now);
  }
  async claim(
    workerId: string,
    leaseMs: number,
    kind?: Kind,
    target?: { tenantId: string; runId: string },
  ) {
    if (kind && !this.kinds[kind])
      throw new ForgeError("invalid_kind", "Desteklenmeyen iş türü.");
    return this.storage.db.transaction().execute(async (tx) => {
      if (this.storage.backend === "sqlite")
        await tx
          .updateTable("queue_fairness")
          .set({ last_claimed: sql`last_claimed` })
          .execute();
      const now = await this.now(tx);
      let candidates = tx
        .selectFrom("runs as r")
        .innerJoin("queue_fairness as f", (join) =>
          join
            .onRef("f.tenant_id", "=", "r.tenant_id")
            .onRef("f.user_id", "=", "r.user_id"),
        )
        .selectAll("r")
        .where((eb) =>
          eb.or([
            eb.and([
              eb("r.state", "in", ["queued", "retry_wait"]),
              eb("r.available_at", "<=", now),
            ]),
            eb.and([
              eb("r.state", "=", "running"),
              eb("r.lease_until", "<", now),
            ]),
          ]),
        )
        .orderBy("f.last_claimed")
        .orderBy("r.created_at")
        .orderBy("r.id")
        .limit(32);
      // Frozen tenants (pending deletion) yield no new work.
      candidates = candidates.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("tenant_lifecycle as l")
              .select("l.tenant_id")
              .whereRef("l.tenant_id", "=", "r.tenant_id")
              .where("l.frozen", "=", 1),
          ),
        ),
      );
      if (kind) candidates = candidates.where("r.kind", "=", kind);
      if (target)
        candidates = candidates
          .where("r.tenant_id", "=", target.tenantId)
          .where("r.id", "=", target.runId);
      if (this.storage.backend === "postgres")
        candidates = candidates.forUpdate("r").skipLocked();
      for (const candidate of await candidates.execute()) {
        if (candidate.state === "running" && candidate.lease_until < now) {
          await tx
            .updateTable("run_attempts")
            .set({ ended_at: now, result: "lease_expired" })
            .where("tenant_id", "=", candidate.tenant_id)
            .where("run_id", "=", candidate.id)
            .where("fence", "=", candidate.fence)
            .where("ended_at", "is", null)
            .execute();
        }
        if (
          candidate.deadline_at <= now ||
          candidate.attempt >= candidate.max_attempts
        ) {
          await tx
            .updateTable("runs")
            .set({
              state: "failed",
              error_code: "deadline_or_attempt_limit",
              updated_at: now,
              lease_until: 0,
            })
            .where("tenant_id", "=", candidate.tenant_id)
            .where("id", "=", candidate.id)
            .where("fence", "=", candidate.fence)
            .execute();
          await this.audit(
            tx,
            candidate,
            "job.finished",
            {
              run_id: candidate.id,
              kind: candidate.kind,
              state: "failed",
              error_code: "deadline_or_attempt_limit",
            },
            now,
          );
          continue;
        }
        // Same actor's claims serialize across workers, enforcing concurrency.
        await tx
          .updateTable("queue_fairness")
          .set({ last_claimed: sql`last_claimed` })
          .where("tenant_id", "=", candidate.tenant_id)
          .where("user_id", "=", candidate.user_id)
          .execute();
        const active = await tx
          .selectFrom("runs")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("tenant_id", "=", candidate.tenant_id)
          .where("user_id", "=", candidate.user_id)
          .where("state", "=", "running")
          .where("lease_until", ">=", now)
          .executeTakeFirstOrThrow();
        const config = JSON.parse(candidate.config_json) as {
          values: { concurrency: number };
        };
        if (Number(active.n) >= config.values.concurrency) continue;
        const claimed = await tx
          .updateTable("runs")
          .set({
            state: "running",
            worker_id: workerId,
            lease_until: now + leaseMs,
            fence: candidate.fence + 1,
            attempt: candidate.attempt + 1,
            updated_at: now,
          })
          .where("tenant_id", "=", candidate.tenant_id)
          .where("id", "=", candidate.id)
          .where("fence", "=", candidate.fence)
          .where("state", "=", candidate.state)
          .returningAll()
          .executeTakeFirst();
        if (!claimed) continue;
        await tx
          .updateTable("queue_fairness")
          .set({ last_claimed: now })
          .where("tenant_id", "=", candidate.tenant_id)
          .where("user_id", "=", candidate.user_id)
          .execute();
        await tx
          .insertInto("run_attempts")
          .values({
            tenant_id: claimed.tenant_id,
            run_id: claimed.id,
            fence: claimed.fence,
            worker_id: workerId,
            started_at: now,
            ended_at: null,
            result: null,
          })
          .execute();
        return claimed;
      }
      return null;
    });
  }
  async heartbeat(run: Run, leaseMs: number) {
    const now = await this.storage.now();
    const result = await this.storage.db
      .updateTable("runs")
      .set({ lease_until: now + leaseMs, updated_at: now })
      .where("tenant_id", "=", run.tenant_id)
      .where("id", "=", run.id)
      .where("state", "=", "running")
      .where("fence", "=", run.fence)
      .where("worker_id", "=", run.worker_id)
      .where("lease_until", ">", now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
  async assertLease(db: Kysely<DB>, run: Run) {
    const now = await this.now(db);
    const current = await db
      .updateTable("runs")
      .set({ fence: sql`fence` })
      .where("tenant_id", "=", run.tenant_id)
      .where("id", "=", run.id)
      .where("state", "=", "running")
      .where("fence", "=", run.fence)
      .where("worker_id", "=", run.worker_id)
      .where("lease_until", ">", now)
      .returning("id")
      .executeTakeFirst();
    if (!current)
      throw new ForgeError(
        "stale_worker",
        "İşin lease sahipliği değişti.",
        409,
      );
    await this.authorizeRun(
      db,
      { userId: run.user_id, tenantId: run.tenant_id },
      run,
      "run",
    );
  }
  /**
   * Issue #34: every read/mutation re-authorizes the persisted scope.
   * Project scope re-checks project `read`/`run`; personal and organization
   * scope re-check the tenant-level permission (the space ACL is enforced by
   * `MemoryService` in the handler and at later commit steps).
   */
  private async authorizeRun(
    db: Kysely<DB>,
    identity: Identity,
    run: Pick<Run, "scope_kind" | "project_id">,
    permission: "read" | "run",
  ) {
    const auth = new IdentityService(db);
    if (run.scope_kind === "project") {
      if (!run.project_id)
        throw new ForgeError("run_unavailable", "İş kapsamı tutarsız.", 404);
      await auth.authorize(identity, permission, run.project_id);
    } else {
      await auth.authorize(identity, permission);
    }
  }
  async finish(
    run: Run,
    state: RunState,
    result: unknown,
    errorCode: string | null = null,
  ) {
    if (!terminalStates.includes(state))
      throw new ForgeError(
        "invalid_transition",
        "Terminal iş durumu gerekiyor.",
      );
    return this.storage.db.transaction().execute(async (tx) => {
      await this.assertLease(tx, run);
      const now = await this.now(tx);
      await tx
        .updateTable("runs")
        .set({
          state,
          result_json: JSON.stringify(result),
          error_code: errorCode,
          updated_at: now,
          lease_until: 0,
        })
        .where("tenant_id", "=", run.tenant_id)
        .where("id", "=", run.id)
        .where("fence", "=", run.fence)
        .execute();
      await tx
        .updateTable("run_attempts")
        .set({ ended_at: now, result: state })
        .where("tenant_id", "=", run.tenant_id)
        .where("run_id", "=", run.id)
        .where("fence", "=", run.fence)
        .execute();
      await this.audit(
        tx,
        run,
        "job.finished",
        {
          run_id: run.id,
          kind: run.kind,
          state,
          error_code: errorCode,
        },
        now,
      );
    });
  }
  async fail(run: Run, code: string, retryable: boolean) {
    const now = await this.storage.now();
    if (!retryable || run.attempt >= run.max_attempts || run.deadline_at <= now)
      return this.finish(run, "failed", null, code);
    await this.storage.db.transaction().execute(async (tx) => {
      await this.assertLease(tx, run);
      await tx
        .updateTable("runs")
        .set({
          state: "retry_wait",
          error_code: code,
          available_at: now + Math.min(30000, 500 * 2 ** run.attempt),
          lease_until: 0,
          updated_at: now,
        })
        .where("tenant_id", "=", run.tenant_id)
        .where("id", "=", run.id)
        .where("fence", "=", run.fence)
        .execute();
      await tx
        .updateTable("outbox")
        .set({ delivered: 0 })
        .where("tenant_id", "=", run.tenant_id)
        .where("run_id", "=", run.id)
        .execute();
      await this.audit(
        tx,
        run,
        "job.retry_scheduled",
        {
          run_id: run.id,
          kind: run.kind,
          error_code: code,
          attempt: run.attempt,
        },
        now,
      );
    });
  }
  async get(identity: Identity, runId: string) {
    const run = await this.storage.db
      .selectFrom("runs")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!run)
      throw new ForgeError(
        "run_unavailable",
        "İş bulunamadı veya yetkiniz yok.",
        404,
      );
    await this.authorizeRun(this.storage.db, identity, run, "read");
    return run;
  }
  async attempts(identity: Identity, runId: string, after = 0) {
    const run = await this.get(identity, runId);
    const rows = await this.storage.db
      .selectFrom("run_attempts")
      .select(["fence", "started_at", "ended_at", "result"])
      .where("tenant_id", "=", identity.tenantId)
      .where("run_id", "=", runId)
      .where("fence", ">", after)
      .orderBy("fence")
      .limit(21)
      .execute();
    return {
      status: run.state,
      items: rows.slice(0, 20),
      next: rows.length > 20 ? rows[19]!.fence : null,
    };
  }
  async cancel(identity: Identity, runId: string) {
    const run = await this.get(identity, runId);
    await this.authorizeRun(this.storage.db, identity, run, "run");
    await this.storage.db.transaction().execute(async (tx) => {
      const now = await this.now(tx);
      const updated = await tx
        .updateTable("runs")
        .set({
          state: "cancelled",
          fence: sql`fence + 1`,
          lease_until: 0,
          updated_at: now,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", run.id)
        .where("state", "not in", terminalStates)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1)
        await this.audit(
          tx,
          run,
          "job.cancelled",
          { run_id: run.id, kind: run.kind },
          now,
        );
    });
  }
}
