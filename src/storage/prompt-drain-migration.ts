import type { Migration } from "kysely/migration";
import type { ExpressionBuilder, Kysely } from "kysely";
// P22 drain runs against rows written by older releases, so it uses its own
// structural table shape instead of the current schema types.
interface DrainTables {
  runs: {
    id: string;
    kind: string;
    state: string;
    error_code: string | null;
    updated_at: number;
    lease_until: number;
  };
  run_attempts: {
    run_id: string;
    ended_at: number | null;
    result: string | null;
  };
}
// P22: the worker only serves skill_evolve; stranded prompt_edit runs can
// never be claimed, swept or retained. Cancel them once with an explicit
// error code instead of letting them occupy queue quota forever.
const TERMINAL = [
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
export const promptDrainMigration: Migration = {
  // Drained runs are terminal (cancelled), so the postgres outbox loop marks
  // their rows delivered without dispatch and the SQLite path ignores them.
  up: async (db: Kysely<DrainTables>) => {
    const now = Date.now();
    await db
      .updateTable("run_attempts")
      .set({ ended_at: now, result: "cancelled" })
      .where("ended_at", "is", null)
      .where(
        "run_id",
        "in",
        (eb: ExpressionBuilder<DrainTables, "run_attempts">) =>
          eb
            .selectFrom("runs")
            .select("id")
            .where("kind", "=", "prompt_edit")
            .where("state", "not in", TERMINAL),
      )
      .execute();
    await db
      .updateTable("runs")
      .set({
        state: "cancelled",
        error_code: "prompt_removed",
        updated_at: now,
        lease_until: 0,
      })
      .where("kind", "=", "prompt_edit")
      .where("state", "not in", TERMINAL)
      .execute();
  },
};
