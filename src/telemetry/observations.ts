import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Insertable } from "kysely";
import { ForgeError } from "../domain/errors.js";
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
  const rows = items.map((item) => ({
    tenant_id: actor.tenantId,
    user_id: actor.userId,
    project_id: project,
    id: randomUUID(),
    skill_id: item.skill_id,
    revision: item.revision,
    kind,
    correlation,
    created_at: Date.now(),
  }));
  if (db.isTransaction) return insert(db, rows);
  let batch = batches.get(db);
  if (!batch) {
    batch = new ObservationBatch(db);
    batches.set(db, batch);
  }
  return batch.add(rows);
}

type Rows = Insertable<DB["skill_observations"]>[];
async function insert(db: Kysely<DB>, rows: Rows) {
  await db
    .insertInto("skill_observations")
    .values(rows)
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

const batches = new WeakMap<Kysely<DB>, ObservationBatch>();
type Pending = {
  rows: Rows;
  resolve: () => void;
  reject: (error: unknown) => void;
};
/** Bounded group commit. Acknowledgements follow commit, including when shutdown drains HTTP. */
class ObservationBatch {
  private queue: Pending[] = [];
  private outstanding = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private db: Kysely<DB>) {}
  add(rows: Rows): Promise<void> {
    if (this.outstanding >= 128)
      return Promise.reject(
        new ForgeError(
          "observation_capacity",
          "Gözlem yazma kapasitesi dolu; yeniden deneyin.",
          429,
        ),
      );
    this.outstanding++;
    const result = new Promise<void>((resolve, reject) => {
      this.queue.push({ rows, resolve, reject });
    });
    this.schedule();
    return result;
  }
  private schedule() {
    if (this.running || !this.queue.length) return;
    if (this.queue.length >= 32) {
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 10);
    }
  }
  private async flush() {
    this.running = true;
    const group = this.queue.splice(0, 32);
    const errors = new Map<Pending, unknown>();
    try {
      await this.db.transaction().execute(async (tx) => {
        for (const item of group) {
          await sql`savepoint forge_observation`.execute(tx);
          try {
            await insert(tx, item.rows);
          } catch (error) {
            await sql`rollback to savepoint forge_observation`.execute(tx);
            errors.set(item, error);
          }
          await sql`release savepoint forge_observation`.execute(tx);
        }
      });
      for (const item of group) {
        if (errors.has(item)) item.reject(errors.get(item));
        else item.resolve();
      }
    } catch (error) {
      for (const item of group) item.reject(error);
    } finally {
      this.outstanding -= group.length;
      this.running = false;
      this.schedule();
    }
  }
}
