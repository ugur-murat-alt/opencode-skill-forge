import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import type { Identity } from "../application/identity.js";
export type ObservationKind =
  | "search_impression"
  | "loaded"
  | "entrypoint_executed"
  | "execution_failed"
  | "exported";
/** Only server-observed facts. Loading is never recorded as successful application. */
export async function observe(
  db: Kysely<DB>,
  actor: Identity,
  project: string,
  kind: ObservationKind,
  items: { skill_id: string; revision: string }[],
  correlation: string = randomUUID(),
) {
  if (!items.length) return;
  await db
    .insertInto("skill_observations")
    .values(
      items.map((item) => ({
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        project_id: project,
        id: randomUUID(),
        skill_id: item.skill_id,
        revision: item.revision,
        kind,
        correlation,
        created_at: Date.now(),
      })),
    )
    .onConflict((oc) =>
      oc
        .columns([
          "tenant_id",
          "user_id",
          "project_id",
          "skill_id",
          "kind",
          "correlation",
        ])
        .doNothing(),
    )
    .execute();
}
