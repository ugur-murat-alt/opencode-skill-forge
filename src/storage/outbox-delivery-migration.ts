import type { Migration } from "kysely/migration";
/** Issue #23: the outbox carries its own bounded delivery schedule and
 * dispatcher ownership so the liveness sweep no longer re-sends a healthy
 * queued run on every pass. `runs` remains the execution source of truth;
 * `runs.available_at` keeps its work-eligibility meaning. */
export const outboxDeliveryMigration: Migration = {
  up: async (db) => {
    await db.schema
      .alterTable("outbox")
      .addColumn("delivered_at", "bigint", (c) => c.notNull().defaultTo(0))
      .execute();
    await db.schema
      .alterTable("outbox")
      .addColumn("delivery_attempts", "integer", (c) =>
        c.notNull().defaultTo(0),
      )
      .execute();
    await db.schema
      .alterTable("outbox")
      .addColumn("dispatch_owner", "text")
      .execute();
    await db.schema
      .alterTable("outbox")
      .addColumn("dispatch_until", "bigint", (c) => c.notNull().defaultTo(0))
      .execute();
  },
};
