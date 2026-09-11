import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { ForgeWorker } from "../src/jobs/worker.js";
import { ForgeError } from "../src/domain/errors.js";

/**
 * Integration-round defect 5: a retryable failure that moves a run to
 * `retry_wait` must close its attempt row so operators can see the attempt
 * outcome instead of a permanently open lease attempt.
 */

async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test("#36 retryable fail closes the attempt with result retry_wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-retry-attempt-"));
  const storage = await openDatabase({ dataDir: root });
  let worker: ForgeWorker | undefined;
  try {
    const identities = new IdentityService(storage.db);
    const owner = await identities.bootstrapLocal();
    const project = await identities.createProject(owner, "Retry attempts");
    const queue = new JobQueue(storage);
    const accepted = await queue.accept(owner, {
      projectId: project.id,
      kind: "skill_evolve",
      key: crypto.randomUUID(),
      payload: { summary: "retry" },
      deadlineMs: 60000,
    });
    worker = new ForgeWorker(
      queue,
      async () => {
        throw new ForgeError("upstream_busy", "Geçici hata.", 429);
      },
      { pollMs: 20, leaseMs: 5000 },
    );
    await worker.start();
    const retried = await until(
      async () =>
        (await queue.get(owner, accepted.run.id)).state === "retry_wait",
      15000,
    );
    expect(retried).toBe(true);
    const attempts = await storage.db
      .selectFrom("run_attempts")
      .selectAll()
      .where("tenant_id", "=", owner.tenantId)
      .where("run_id", "=", accepted.run.id)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.ended_at).not.toBeNull();
    expect(attempts[0]!.result).toBe("retry_wait");
  } finally {
    await worker?.stop();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
