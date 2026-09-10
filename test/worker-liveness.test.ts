import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { ForgeWorker } from "../src/jobs/worker.js";

/**
 * Issue #11: when the claim path keeps failing, pg-boss exhausts its retry
 * budget while the application run stays `queued` with a delivered outbox
 * entry — a dead end. The worker's liveness sweep must re-deliver stale
 * queued runs within a bounded window so the run either executes or is
 * terminalized by its deadline. Real PostgreSQL + real pg-boss.
 */
test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P1 #11 queued liveness: claim failures exhaust retries, sweep re-delivers",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-liveness-"));
    const storage = await openDatabase({
      dataDir: root,
      postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
    });
    const identity = new IdentityService(storage.db);
    const owner = await identity.bootstrapLocal();
    const project = await identity.createProject(owner, "Liveness");
    const queue = new JobQueue(storage);
    const originalClaim = queue.claim.bind(queue);
    let claimCalls = 0;
    queue.claim = ((...args: Parameters<JobQueue["claim"]>) => {
      claimCalls += 1;
      if (claimCalls <= 6) return Promise.reject(new Error("run_not_ready"));
      return originalClaim(...args);
    }) as JobQueue["claim"];
    let executions = 0;
    const stderrChunks: string[] = [];
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let worker: ForgeWorker | undefined;
    try {
      worker = new ForgeWorker(
        queue,
        async (run) => {
          executions += 1;
          return {
            state: "completed",
            result: { decision: "create", run_id: run.id },
          };
        },
        {
          postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
          pollMs: 50,
          livenessMs: 3000,
        },
      );
      await worker.start();
      const accepted = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "Liveness proof" },
      });
      // Teslim sonrası claim hatası: 1 deneme + 3 pg-boss tekrar boşa gider.
      const runId = accepted.run.id;
      const deadline = Date.now() + 60_000;
      let state = (await queue.get(owner, runId)).state;
      while (
        Date.now() < deadline &&
        !["completed", "failed"].includes(state)
      ) {
        await new Promise((r) => setTimeout(r, 100));
        state = (await queue.get(owner, runId)).state;
      }
      // Süresiz queued kalma yok: sınırlı pencerede terminal sonuç.
      expect(["completed", "failed"]).toContain(state);
      expect(state).toBe("completed");
      // Tekil yan etki: yeniden teslim yürütmeyi çoğaltmaz, stale worker
      // yayın yapamaz (fencing) — tam olarak bir başarılı claim/yürütme.
      expect(executions).toBe(1);
      const attempts = await storage.db
        .selectFrom("run_attempts")
        .select("id")
        .where("tenant_id", "=", owner.tenantId)
        .where("run_id", "=", runId)
        .execute();
      expect(attempts).toHaveLength(1);
      // Operatör gözlemlenebilirliği: yetim yeniden teslim raporlanır.
      expect(
        stderrChunks.some((c) => c.includes("queued iş teslim penceresi aştı")),
      ).toBe(true);
    } finally {
      process.stderr.write = stderrWrite;
      await worker?.stop();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  70_000,
);
