import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { sql } from "kysely";
import { JobQueue, terminalStates } from "./queue.js";
import type { Run, RunState } from "../storage/schema.js";
import { ForgeError } from "../domain/errors.js";
import type { DefaultJobKind } from "../domain/job-kinds.js";
export type JobHandler = (
  run: Run,
  signal: AbortSignal,
) => Promise<{ state: RunState; result: unknown; errorCode?: string }>;
export interface ForgeWorkerOptions<Kind extends string> {
  postgresUrl?: string;
  leaseMs?: number;
  pollMs?: number;
  /** Bounded liveness window before a lost delivery is re-sent. */
  livenessMs?: number;
  /** Dispatcher ownership lease for an outbox row. */
  dispatchLeaseMs?: number;
  /**
   * Issue #32: kind-specific handlers. The positional `handler` stays the
   * default (and the skill handler in production); kinds without an entry
   * fall back to it, so existing `new ForgeWorker(queue, handler, options)`
   * callers are unchanged.
   */
  handlers?: Partial<Record<Kind, JobHandler>>;
}
export class ForgeWorker<Kind extends string = DefaultJobKind> {
  readonly id = randomUUID();
  private stopping = false;
  private boss?: PgBoss;
  private loops: Promise<void>[] = [];
  private controllers = new Set<AbortController>();
  private sweepChain: Promise<void> = Promise.resolve();
  /** pg-boss states whose job still owns (or will own) a transport slot. */
  private static readonly liveTransportStates = new Set([
    "created",
    "retry",
    "active",
  ]);
  constructor(
    readonly queue: JobQueue<Kind>,
    readonly handler: JobHandler,
    readonly options: ForgeWorkerOptions<Kind> = {},
  ) {}
  private kinds(): Kind[] {
    return Object.keys(this.queue.kinds) as Kind[];
  }
  private handlerFor(kind: string): JobHandler {
    const handlers = this.options.handlers as
      Record<string, JobHandler | undefined> | undefined;
    return handlers?.[kind] ?? this.handler;
  }
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
      for (const kind of this.kinds()) {
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
      for (const kind of this.kinds()) this.loops.push(this.localLoop(kind));
  }
  /** Is a pg-boss job for this run still pending or executing? */
  private async transportActive(kind: Run["kind"], runId: string) {
    const jobs = await this.boss!.findJobs(kind, { key: runId });
    return jobs.some((job) => ForgeWorker.liveTransportStates.has(job.state));
  }
  /** Hand back dispatcher ownership after an inspected row was not sent. */
  private async releaseDispatch(tenantId: string, runId: string) {
    await this.queue.storage.db
      .updateTable("outbox")
      .set({ dispatch_owner: null, dispatch_until: 0 })
      .where("tenant_id", "=", tenantId)
      .where("run_id", "=", runId)
      .where("dispatch_owner", "=", this.id)
      .execute();
  }
  /**
   * One outbox liveness pass (issues #11, #23). `runs` stays the source of
   * truth. The outbox carries its own bounded delivery schedule: only after
   * the liveness window passes does the sweep inspect the transport. A
   * pending/executing pg-boss job renews the window; a missing or terminal
   * job authorizes one deduplicated re-send. One dispatcher owns a row at a
   * time, so concurrent workers cannot re-send it in parallel, and a stale
   * execution lease re-delivers even while an old transport job is still
   * marked active (the executor is gone; fencing protects the run).
   *
   * Sweeps are serialized per worker instance: the background loop and a
   * direct call must never process the same outbox row concurrently.
   */
  async sweepOutbox() {
    const next = this.sweepChain.then(() => this.performSweep());
    this.sweepChain = next.catch(() => undefined);
    return next;
  }
  private async performSweep() {
    if (!this.boss) return;
    const storage = this.queue.storage;
    const now = await storage.now();
    const livenessMs = this.options.livenessMs ?? 60_000;
    const dispatchLeaseMs =
      this.options.dispatchLeaseMs ?? Math.max(2000, livenessMs);
    const windowStart = now - livenessMs;
    const due = await storage.db
      .selectFrom("outbox as o")
      .innerJoin("runs as r", (join) =>
        join
          .onRef("o.tenant_id", "=", "r.tenant_id")
          .onRef("o.run_id", "=", "r.id"),
      )
      .select([
        "o.tenant_id",
        "o.run_id",
        "o.delivered",
        "o.delivered_at",
        "o.delivery_attempts",
        "r.user_id",
        "r.kind",
        "r.state",
        "r.available_at",
        "r.lease_until",
      ])
      .where("r.state", "not in", terminalStates)
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
      .where((eb) =>
        eb.or([
          eb("o.dispatch_until", "<=", now),
          eb("o.dispatch_owner", "is", null),
        ]),
      )
      .where((eb) =>
        eb.or([
          // Fresh or reset work: never delivered, or a new attempt is due.
          eb.and([
            eb("o.delivered", "=", 0),
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
          ]),
          // Previously delivered: the bounded window expired, so the
          // transport state decides between renew and re-deliver.
          eb.and([
            eb("o.delivered", "=", 1),
            eb("o.delivered_at", "<=", windowStart),
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
          ]),
        ]),
      )
      .orderBy("r.created_at")
      .orderBy("r.id")
      .limit(100)
      .execute();
    let redeliveries = 0;
    for (const candidate of due) {
      // Exactly one dispatcher owns a row; a crashed owner is recovered
      // after `dispatchLeaseMs`.
      const claim = await storage.db
        .updateTable("outbox")
        .set({ dispatch_owner: this.id, dispatch_until: now + dispatchLeaseMs })
        .where("tenant_id", "=", candidate.tenant_id)
        .where("run_id", "=", candidate.run_id)
        .where((eb) =>
          eb.or([
            eb("dispatch_until", "<=", now),
            eb("dispatch_owner", "is", null),
          ]),
        )
        // The row must still be due: another dispatcher may have delivered
        // or renewed it between selection and this claim.
        .where((eb) =>
          eb.or([
            eb("delivered", "=", 0),
            eb("delivered_at", "<=", windowStart),
          ]),
        )
        .executeTakeFirst();
      if (Number(claim.numUpdatedRows) !== 1) continue;
      const box = await storage.db
        .selectFrom("outbox")
        .select(["delivered", "delivered_at"])
        .where("tenant_id", "=", candidate.tenant_id)
        .where("run_id", "=", candidate.run_id)
        .executeTakeFirst();
      if (!box) continue;
      const current = await storage.db
        .selectFrom("runs")
        .select(["state", "available_at", "lease_until"])
        .where("tenant_id", "=", candidate.tenant_id)
        .where("id", "=", candidate.run_id)
        .executeTakeFirst();
      if (!current || terminalStates.includes(current.state)) {
        await this.releaseDispatch(candidate.tenant_id, candidate.run_id);
        continue;
      }
      const executorLost =
        current.state === "running" && current.lease_until < now;
      const workDue =
        (current.state === "queued" || current.state === "retry_wait") &&
        current.available_at <= now;
      if (!executorLost && !workDue) {
        await this.releaseDispatch(candidate.tenant_id, candidate.run_id);
        continue;
      }
      if (!executorLost && box.delivered === 1) {
        if (await this.transportActive(candidate.kind, candidate.run_id)) {
          // One successful send opens a new window; a healthy transport job
          // is renewed, never re-sent on every sweep.
          await storage.db
            .updateTable("outbox")
            .set({ delivered_at: now, dispatch_owner: null, dispatch_until: 0 })
            .where("tenant_id", "=", candidate.tenant_id)
            .where("run_id", "=", candidate.run_id)
            .execute();
          continue;
        }
        redeliveries += 1;
      }
      await this.boss.send(
        candidate.kind,
        { tenantId: candidate.tenant_id, runId: candidate.run_id },
        {
          singletonKey: candidate.run_id,
          singletonSeconds: 1,
          startAfter: new Date(current.available_at),
          group: { id: `${candidate.tenant_id}:${candidate.user_id}` },
        },
      );
      await storage.db
        .updateTable("outbox")
        .set({
          delivered: 1,
          delivered_at: now,
          delivery_attempts: sql`delivery_attempts + 1`,
          dispatch_owner: null,
          dispatch_until: 0,
        })
        .where("tenant_id", "=", candidate.tenant_id)
        .where("run_id", "=", candidate.run_id)
        .execute();
    }
    if (redeliveries)
      process.stderr.write(
        `Kuyruk uzlaştırması: ${redeliveries} queued iş teslim penceresi aştı; yeniden teslim ediliyor\n`,
      );
  }
  private async pause() {
    await new Promise((resolve) =>
      setTimeout(resolve, this.options.pollMs ?? 100),
    );
  }
  private async localLoop(kind: Kind) {
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
      const result = await this.handlerFor(run.kind)(run, controller.signal);
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
