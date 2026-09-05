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
      for (const kind of ["prompt_edit", "skill_evolve"] as const) {
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
    } else
      this.loops.push(
        this.localLoop("prompt_edit"),
        this.localLoop("skill_evolve"),
      );
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
        const now = await this.queue.storage.now();
        const stranded = this.queue.storage.db
          .selectFrom("runs")
          .select("id")
          .where((eb) =>
            eb.or([
              eb.and([
                eb("state", "=", "running"),
                eb("lease_until", "<", now),
              ]),
              eb.and([
                eb("state", "=", "retry_wait"),
                eb("available_at", "<=", now),
              ]),
            ]),
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
