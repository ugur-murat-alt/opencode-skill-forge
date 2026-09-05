import { sql } from "kysely";
import type { DatabaseHandle } from "../storage/database.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { ForgeError } from "../domain/errors.js";
/** Reservations remain held after an uncertain provider call until explicit reconciliation. */
export class BudgetService {
  constructor(readonly storage: DatabaseHandle) {}
  async reserve(
    identity: Identity,
    runId: string,
    reservationId: string,
    micros: number,
  ) {
    if (!Number.isSafeInteger(micros) || micros < 0)
      throw new ForgeError("invalid_budget", "Bütçe rezervasyonu geçersiz.");
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
      await new IdentityService(tx).authorize(identity, "run", run.project_id);
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
      if (
        account.reserved_micros + account.spent_micros + micros >
        account.limit_micros
      )
        throw new ForgeError(
          "budget_exhausted",
          "Hesap bütçesi yetersiz.",
          429,
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
}
