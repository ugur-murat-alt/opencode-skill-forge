import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { JobQueue, terminalStates } from "./queue.js";
import type { Run, RunState } from "../storage/schema.js";
import { ForgeError } from "../domain/errors.js";
export type JobHandler = (
  run: Run,
  signal: AbortSignal,
) => Promise<{ state: RunState; result: unknown; errorCode?: string }>;
export class ForgeWorker {
  readonly id = randomUUID();
  private stopping = false;
  private boss?: PgBoss;
  private loops: Promise<void>[] = [];
  private controllers = new Set<AbortController>();
  constructor(
    readonly queue: JobQueue,
    readonly handler: JobHandler,
    readonly options: {
      postgresUrl?: string;
      leaseMs?: number;
      pollMs?: number;
      /** Bounded liveness window before a stale queued run is re-delivered. */
      livenessMs?: number;
    } = {},
  ) {}
  async start() {
    if (this.options.postgresUrl) {
      this.boss = new PgBoss({
        connectionString: this.options.postgresUrl,
        application_name: "skill-forge-worker",
      });
      this.boss.on("error", () => {
        process.stderr.write("pg-boss queue error\n");
      });
      await this.boss.start();
      for (const kind of ["skill_evolve"] as const) {
        await this.boss.createQueue(kind, {
          retryLimit: 3,
          retryDelay: 1,
          retryBackoff: true,
          expireInSeconds: 3600,
        });
        await this.boss.work<{ tenantId: string; runId: string }>(
          kind,
          {
            localConcurrency: 2,
            groupConcurrency: 1,
            pollingIntervalSeconds: 0.5,
          },
          async (jobs) => {
            for (const job of jobs) {
              const run = await this.queue.claim(
                this.id,
                this.options.leaseMs ?? 15000,
                kind,
                job.data,
              );
              if (run) await this.execute(run);
              else {
                const current = await this.queue.storage.db
                  .selectFrom("runs")
                  .select("state")
                  .where("tenant_id", "=", job.data.tenantId)
                  .where("id", "=", job.data.runId)
                  .executeTakeFirst();
                if (current && !terminalStates.includes(current.state))
                  throw new Error("run_not_ready");
              }
            }
          },
        );
      }
      this.loops.push(this.outboxLoop());
    } else this.loops.push(this.localLoop("skill_evolve"));
  }
  /**
   * One outbox liveness pass (issue #11). The application `runs` row is the
   * source of truth: every nonterminal run whose delivery claim died (pg-boss
   * retry exhaustion, worker crash) must be re-delivered within a bounded
   * window instead of stalling in `queued` forever.
   */
  async sweepOutbox() {
    if (!this.boss) return;
    const now = await this.queue.storage.now();
    const livenessMs = this.options.livenessMs ?? 60_000;
    const stranded = this.queue.storage.db
      .selectFrom("runs")
      .select("id")
      .where((eb) =>
        eb.or([
          eb.and([eb("state", "=", "running"), eb("lease_until", "<", now)]),
          eb.and([
            eb("state", "=", "retry_wait"),
            eb("available_at", "<=", now),
          ]),
          // Stale `queued` liveness: the outbox says delivered but no pg-boss
          // job can claim it anymore (retry budget exhausted while the claim
          // path was failing). Re-deliver after the bounded window.
          eb.and([
            eb("state", "=", "queued"),
            eb("available_at", "<=", now - livenessMs),
          ]),
        ]),
      );
    const orphans = await this.queue.storage.db
      .selectFrom("runs as r")
      .innerJoin("outbox as o", (join) =>
        join
          .onRef("o.tenant_id", "=", "r.tenant_id")
          .onRef("o.run_id", "=", "r.id"),
      )
      .select("r.id")
      .where("r.state", "=", "queued")
      .where("o.delivered", "=", 1)
      .where("r.available_at", "<=", now - livenessMs)
      .limit(100)
      .execute();
    if (orphans.length)
      process.stderr.write(
        `Kuyruk uzlaştırması: ${orphans.length} queued iş teslim penceresi aştı; yeniden teslim ediliyor\n`,
      );
    await this.queue.storage.db
      .updateTable("outbox")
      .set({ delivered: 0 })
      .where("run_id", "in", stranded)
      .execute();
    const pending = await this.queue.storage.db
      .selectFrom("outbox as o")
      .innerJoin("runs as r", (join) =>
        join
          .onRef("r.tenant_id", "=", "o.tenant_id")
          .onRef("r.id", "=", "o.run_id"),
      )
      .select([
        "r.tenant_id",
        "r.id",
        "r.user_id",
        "r.kind",
        "r.available_at",
        "r.state",
      ])
      .where("o.delivered", "=", 0)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("tenant_lifecycle as l")
              .select("l.tenant_id")
              .whereRef("l.tenant_id", "=", "r.tenant_id")
              .where("l.frozen", "=", 1),
          ),
        ),
      )
      .limit(100)
      .execute();
    for (const run of pending) {
      if (!terminalStates.includes(run.state))
        await this.boss!.send(
          run.kind,
          { tenantId: run.tenant_id, runId: run.id },
          {
            singletonKey: run.id,
            singletonSeconds: 1,
            startAfter: new Date(run.available_at),
            group: { id: `${run.tenant_id}:${run.user_id}` },
          },
        );
      await this.queue.storage.db
        .updateTable("outbox")
        .set({ delivered: 1 })
        .where("tenant_id", "=", run.tenant_id)
        .where("run_id", "=", run.id)
        .execute();
    }
  }
  private async pause() {
    await new Promise((resolve) =>
      setTimeout(resolve, this.options.pollMs ?? 100),
    );
  }
  private async localLoop(kind: Run["kind"]) {
    while (!this.stopping) {
      try {
        const run = await this.queue.claim(
          this.id,
          this.options.leaseMs ?? 15000,
          kind,
        );
        if (run) await this.execute(run);
        else await this.pause();
      } catch {
        process.stderr.write("Yerel iş kuyruğu yeniden denenecek\n");
        await this.pause();
      }
    }
  }
  private async outboxLoop() {
    while (!this.stopping) {
      try {
        await this.sweepOutbox();
      } catch {
        process.stderr.write("Outbox teslimi yeniden denenecek\n");
      }
      await this.pause();
    }
  }
  private async execute(run: Run) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const leaseMs = this.options.leaseMs ?? 15000;
    const heartbeat = setInterval(
      () => {
        void this.queue
          .heartbeat(run, leaseMs)
          .then((ok) => {
            if (!ok) controller.abort();
          })
          .catch(() => controller.abort());
      },
      Math.max(20, Math.floor(leaseMs / 3)),
    );
    try {
      const result = await this.handler(run, controller.signal);
      if (!controller.signal.aborted)
        await this.queue.finish(
          run,
          result.state,
          result.result,
          result.errorCode ?? null,
        );
    } catch (error) {
      if (
        !(error instanceof ForgeError && error.code === "stale_worker") &&
        !controller.signal.aborted
      ) {
        try {
          await this.queue.fail(
            run,
            error instanceof ForgeError ? error.code : "worker_error",
            error instanceof ForgeError &&
              [429, 502, 503, 504].includes(error.status),
          );
        } catch {
          controller.abort();
        }
      }
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(controller);
    }
  }
  async stop() {
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    await this.boss?.stop({ graceful: true, timeout: 5000 });
    await Promise.allSettled(this.loops);
  }
}
