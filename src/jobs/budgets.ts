import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../storage/database.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
/** Split accounting for a user's reservations, as reported to operators. */
export interface BudgetAccountSummary {
  /** Normal in-flight provider calls (state `reserved`). */
  reserved_micros: number;
  /** Calls whose provider outcome is unknown (state `unknown`); the held
   * amount stays accounted until an explicit reconciliation records the
   * actual usage. */
  uncertain_micros: number;
  /** Settled actual spending. Never reset by a policy revision. */
  spent_micros: number;
  uncertain_reservations: {
    id: string;
    run_id: string;
    /** Null for personal/organization-scope runs (non-project memory jobs). */
    project_id: string | null;
    reserved_micros: number;
  }[];
}
/**
 * Issue #25: `maxCostMicros` is the accepted job's spending/reservation
 * limit, never a user-wide lifetime quota. `budget_accounts` is an
 * accounting ledger (limit of the most recent reconciled job, held
 * reservations and settled spending); a reservation is checked against its
 * own run's held total plus the effective job limit for that run.
 *
 * A normal in-flight reservation never freezes a policy revision: a new
 * limit applies immediately to new reservations while already held amounts
 * and settled spending stay on the books. Only an explicit, audited
 * `resolveReservation` releases a held (in-flight or uncertain) amount.
 */
export class BudgetService {
  constructor(readonly storage: DatabaseHandle) {}
  /**
   * Records the current effective job limit for callers that do not pin an
   * accepted snapshot limit. Applies immediately, even while calls are in
   * flight, and never touches reserved/spent accounting.
   */
  async reconcileAccount(identity: Identity, jobLimitMicros: number) {
    if (!Number.isSafeInteger(jobLimitMicros) || jobLimitMicros < 0)
      throw new ForgeError("invalid_budget", "Bütçe limiti geçersiz.");
    await this.storage.db
      .insertInto("budget_accounts")
      .values({
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        limit_micros: jobLimitMicros,
        reserved_micros: 0,
        spent_micros: 0,
      })
      .onConflict((oc) =>
        oc
          .columns(["tenant_id", "user_id"])
          .doUpdateSet({ limit_micros: jobLimitMicros }),
      )
      .execute();
  }
  /**
   * Reserves one provider call. `jobLimitMicros` is the accepted job's
   * snapshot limit; when omitted the account's most recently reconciled
   * limit is used as the caller-provided job limit. The check is scoped to
   * this run: other runs' spending or holds are accounting, not quota.
   */
  async reserve(
    identity: Identity,
    runId: string,
    reservationId: string,
    micros: number,
    jobLimitMicros?: number,
  ) {
    if (!Number.isSafeInteger(micros) || micros < 0)
      throw new ForgeError("invalid_budget", "Bütçe rezervasyonu geçersiz.");
    if (
      jobLimitMicros !== undefined &&
      (!Number.isSafeInteger(jobLimitMicros) || jobLimitMicros < 0)
    )
      throw new ForgeError("invalid_budget", "İş bütçesi limiti geçersiz.");
    return this.storage.db.transaction().execute(async (tx) => {
      const run = await tx
        .selectFrom("runs")
        .select(["user_id", "project_id"])
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", runId)
        .executeTakeFirst();
      if (!run || run.user_id !== identity.userId)
        throw new ForgeError(
          "run_unavailable",
          "Rezervasyon işi bu kullanıcıya ait değil.",
          404,
        );
      await new IdentityService(tx).authorize(
        identity,
        "run",
        run.project_id ?? undefined,
      );
      const account = await tx
        .updateTable("budget_accounts")
        .set({ reserved_micros: sql`reserved_micros` })
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .returningAll()
        .executeTakeFirst();
      if (!account)
        throw new ForgeError(
          "budget_unconfigured",
          "Kullanıcı bütçesi tanımlanmamış.",
          422,
        );
      const existing = await tx
        .selectFrom("budget_reservations")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", reservationId)
        .where("user_id", "=", identity.userId)
        .executeTakeFirst();
      if (existing) {
        if (existing.run_id !== runId || existing.reserved_micros !== micros)
          throw new ForgeError(
            "reservation_conflict",
            "Rezervasyon kimliği farklı çağrıya ait.",
            409,
          );
        return existing;
      }
      const jobLimit = jobLimitMicros ?? account.limit_micros;
      // Held total for THIS run: settled actuals plus the held amount of
      // every open reservation (in-flight and uncertain alike). A run's own
      // job limit bounds it; other runs and past jobs never do.
      const heldRow = await tx
        .selectFrom("budget_reservations")
        .select(
          sql<number>`coalesce(sum(case when state = 'settled' then coalesce(actual_micros, 0) else reserved_micros end), 0)`.as(
            "held",
          ),
        )
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("run_id", "=", runId)
        .executeTakeFirstOrThrow();
      const runHeld = Number(heldRow.held);
      if (runHeld + micros > jobLimit)
        throw new ForgeError(
          "budget_exhausted",
          "İş bütçesi yetersiz.",
          429,
          undefined,
          {
            job_limit_micros: jobLimit,
            run_held_micros: runHeld,
            requested_micros: micros,
          },
        );
      await tx
        .updateTable("budget_accounts")
        .set({ reserved_micros: sql`reserved_micros + ${micros}` })
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .execute();
      const record = {
        tenant_id: identity.tenantId,
        id: reservationId,
        user_id: identity.userId,
        run_id: runId,
        reserved_micros: micros,
        actual_micros: null,
        state: "reserved" as const,
      };
      await tx.insertInto("budget_reservations").values(record).execute();
      return record;
    });
  }
  async settle(
    identity: Identity,
    reservationId: string,
    actualMicros: number | null,
  ) {
    if (
      actualMicros !== null &&
      (!Number.isSafeInteger(actualMicros) || actualMicros < 0)
    )
      throw new ForgeError("invalid_usage", "Maliyet ölçümü geçersiz.");
    return this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("budget_accounts")
        .set({ reserved_micros: sql`reserved_micros` })
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .execute();
      const reservation = await tx
        .selectFrom("budget_reservations")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .where("id", "=", reservationId)
        .executeTakeFirstOrThrow();
      if (reservation.state === "settled") {
        if (actualMicros !== reservation.actual_micros)
          throw new ForgeError(
            "settlement_conflict",
            "Çağrı daha önce farklı maliyetle uzlaştırıldı.",
            409,
          );
        return;
      }
      if (actualMicros === null) {
        await tx
          .updateTable("budget_reservations")
          .set({ state: "unknown" })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", reservationId)
          .execute();
        return;
      }
      await tx
        .updateTable("budget_accounts")
        .set({
          reserved_micros: sql`reserved_micros - ${reservation.reserved_micros}`,
          spent_micros: sql`spent_micros + ${actualMicros}`,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .execute();
      await tx
        .updateTable("budget_reservations")
        .set({ state: "settled", actual_micros: actualMicros })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", reservationId)
        .execute();
    });
  }
  /**
   * Issue #25: the authorized manual recovery path for a held reservation
   * whose provider outcome is unknown (or a crashed call left reserved).
   * The caller MUST record an explicit actual amount: the hold is released
   * and the amount becomes settled spending, so an uncertain or real cost is
   * never silently zeroed. Repeating the same amount is idempotent.
   */
  async resolveReservation(
    identity: Identity,
    reservationId: string,
    actualMicros: number,
  ) {
    if (!Number.isSafeInteger(actualMicros) || actualMicros < 0)
      throw new ForgeError("invalid_usage", "Maliyet ölçümü geçersiz.");
    return this.storage.db.transaction().execute(async (tx) => {
      // Serialize with settle/reserve on the account row before reading the
      // hold: a concurrent settle must be observed as settled, never counted
      // down twice.
      await tx
        .updateTable("budget_accounts")
        .set({ reserved_micros: sql`reserved_micros` })
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .execute();
      const reservation = await tx
        .selectFrom("budget_reservations as b")
        .innerJoin("runs as r", (join) =>
          join
            .onRef("r.tenant_id", "=", "b.tenant_id")
            .onRef("r.id", "=", "b.run_id"),
        )
        .select([
          "b.run_id",
          "b.reserved_micros",
          "b.actual_micros",
          "b.state",
          "r.project_id",
        ])
        .where("b.tenant_id", "=", identity.tenantId)
        .where("b.user_id", "=", identity.userId)
        .where("b.id", "=", reservationId)
        .executeTakeFirst();
      if (!reservation)
        throw new ForgeError(
          "reservation_unavailable",
          "Rezervasyon bulunamadı veya yetkiniz yok.",
          404,
        );
      await new IdentityService(tx).authorize(
        identity,
        "run",
        reservation.project_id ?? undefined,
      );
      if (reservation.state === "settled") {
        if (reservation.actual_micros !== actualMicros)
          throw new ForgeError(
            "settlement_conflict",
            "Çağrı daha önce farklı maliyetle uzlaştırıldı.",
            409,
          );
        return {
          id: reservationId,
          run_id: reservation.run_id,
          project_id: reservation.project_id,
          state: "settled" as const,
          reserved_micros: reservation.reserved_micros,
          actual_micros: actualMicros,
        };
      }
      await tx
        .updateTable("budget_accounts")
        .set({
          reserved_micros: sql`reserved_micros - ${reservation.reserved_micros}`,
          spent_micros: sql`spent_micros + ${actualMicros}`,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .execute();
      await tx
        .updateTable("budget_reservations")
        .set({ state: "settled", actual_micros: actualMicros })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", reservationId)
        .execute();
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: identity.tenantId,
          id: randomUUID(),
          user_id: identity.userId,
          project_id: reservation.project_id,
          kind: "budget.reservation_reconciled",
          detail: JSON.stringify({
            reservation_id: reservationId,
            run_id: reservation.run_id,
            previous_state: reservation.state,
            reserved_micros: reservation.reserved_micros,
            actual_micros: actualMicros,
          }),
          created_at: Date.now(),
        })
        .execute();
      return {
        id: reservationId,
        run_id: reservation.run_id,
        project_id: reservation.project_id,
        state: "settled" as const,
        reserved_micros: reservation.reserved_micros,
        actual_micros: actualMicros,
      };
    });
  }
  /** Clear, split reporting of the user's budget ledger. */
  async accountSummary(identity: Identity): Promise<BudgetAccountSummary> {
    const [account, held, uncertain] = await Promise.all([
      this.storage.db
        .selectFrom("budget_accounts")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .executeTakeFirst(),
      this.storage.db
        .selectFrom("budget_reservations")
        .select([
          sql<number>`coalesce(sum(case when state = 'reserved' then reserved_micros else 0 end), 0)`.as(
            "in_flight",
          ),
          sql<number>`coalesce(sum(case when state = 'unknown' then reserved_micros else 0 end), 0)`.as(
            "uncertain",
          ),
        ])
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .executeTakeFirstOrThrow(),
      this.storage.db
        .selectFrom("budget_reservations as b")
        .innerJoin("runs as r", (join) =>
          join
            .onRef("r.tenant_id", "=", "b.tenant_id")
            .onRef("r.id", "=", "b.run_id"),
        )
        .select(["b.id", "b.run_id", "b.reserved_micros", "r.project_id"])
        .where("b.tenant_id", "=", identity.tenantId)
        .where("b.user_id", "=", identity.userId)
        .where("b.state", "=", "unknown")
        .orderBy("b.id")
        .limit(20)
        .execute(),
    ]);
    return {
      reserved_micros: Number(held.in_flight),
      uncertain_micros: Number(held.uncertain),
      spent_micros: account?.spent_micros ?? 0,
      uncertain_reservations: uncertain.map((row) => ({
        id: row.id,
        run_id: row.run_id,
        project_id: row.project_id,
        reserved_micros: row.reserved_micros,
      })),
    };
  }
}
