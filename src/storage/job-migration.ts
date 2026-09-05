import type { Migration } from "kysely/migration";
export const jobMigration: Migration = {
  up: async (db) => {
    await db.schema
      .createTable("forge_sessions")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addPrimaryKeyConstraint("fs_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "fs_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "fs_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .execute();
    await db.schema
      .createTable("runs")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("session_id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("project_id", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("idempotency_key", "text", (c) => c.notNull())
      .addColumn("input_hash", "text", (c) => c.notNull())
      .addColumn("input_json", "text", (c) => c.notNull())
      .addColumn("config_json", "text", (c) => c.notNull())
      .addColumn("result_json", "text")
      .addColumn("error_code", "text")
      .addColumn("created_at", "bigint", (c) => c.notNull())
      .addColumn("updated_at", "bigint", (c) => c.notNull())
      .addColumn("available_at", "bigint", (c) => c.notNull())
      .addColumn("deadline_at", "bigint", (c) => c.notNull())
      .addColumn("lease_until", "bigint", (c) => c.notNull().defaultTo(0))
      .addColumn("worker_id", "text")
      .addColumn("fence", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("attempt", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("max_attempts", "integer", (c) => c.notNull().defaultTo(3))
      .addPrimaryKeyConstraint("run_pk", ["tenant_id", "id"])
      .addUniqueConstraint("run_dedup", [
        "tenant_id",
        "user_id",
        "project_id",
        "kind",
        "idempotency_key",
      ])
      .addForeignKeyConstraint(
        "run_project",
        ["tenant_id", "project_id"],
        "projects",
        ["tenant_id", "id"],
      )
      .addForeignKeyConstraint(
        "run_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "run_session",
        ["tenant_id", "session_id"],
        "forge_sessions",
        ["tenant_id", "id"],
      )
      .execute();
    await db.schema
      .createIndex("run_claim")
      .on("runs")
      .columns(["state", "available_at", "lease_until", "created_at"])
      .execute();
    await db.schema
      .createIndex("run_user_state")
      .on("runs")
      .columns(["tenant_id", "user_id", "state"])
      .execute();
    await db.schema
      .createTable("outbox")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("run_id", "text", (c) => c.notNull())
      .addColumn("delivered", "integer", (c) => c.notNull().defaultTo(0))
      .addPrimaryKeyConstraint("outbox_pk", ["tenant_id", "run_id"])
      .addForeignKeyConstraint("outbox_run", ["tenant_id", "run_id"], "runs", [
        "tenant_id",
        "id",
      ])
      .execute();
    await db.schema
      .createTable("run_attempts")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("run_id", "text", (c) => c.notNull())
      .addColumn("fence", "integer", (c) => c.notNull())
      .addColumn("worker_id", "text", (c) => c.notNull())
      .addColumn("started_at", "bigint", (c) => c.notNull())
      .addColumn("ended_at", "bigint")
      .addColumn("result", "text")
      .addPrimaryKeyConstraint("attempt_pk", ["tenant_id", "run_id", "fence"])
      .addForeignKeyConstraint("attempt_run", ["tenant_id", "run_id"], "runs", [
        "tenant_id",
        "id",
      ])
      .execute();
    await db.schema
      .createTable("queue_fairness")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("last_claimed", "bigint", (c) => c.notNull().defaultTo(0))
      .addPrimaryKeyConstraint("fairness_pk", ["tenant_id", "user_id"])
      .addForeignKeyConstraint(
        "fair_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .execute();
    await db.schema
      .createTable("budget_accounts")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("limit_micros", "bigint", (c) => c.notNull())
      .addColumn("reserved_micros", "bigint", (c) => c.notNull().defaultTo(0))
      .addColumn("spent_micros", "bigint", (c) => c.notNull().defaultTo(0))
      .addPrimaryKeyConstraint("budget_account_pk", ["tenant_id", "user_id"])
      .addForeignKeyConstraint(
        "budget_member",
        ["tenant_id", "user_id"],
        "memberships",
        ["tenant_id", "user_id"],
      )
      .execute();
    await db.schema
      .createTable("budget_reservations")
      .addColumn("tenant_id", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull())
      .addColumn("run_id", "text", (c) => c.notNull())
      .addColumn("reserved_micros", "bigint", (c) => c.notNull())
      .addColumn("actual_micros", "bigint")
      .addColumn("state", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("reservation_pk", ["tenant_id", "id"])
      .addForeignKeyConstraint(
        "reservation_account",
        ["tenant_id", "user_id"],
        "budget_accounts",
        ["tenant_id", "user_id"],
      )
      .addForeignKeyConstraint(
        "reservation_run",
        ["tenant_id", "run_id"],
        "runs",
        ["tenant_id", "id"],
      )
      .execute();
  },
};
