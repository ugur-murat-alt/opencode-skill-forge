import { Client as PgClient } from "pg";
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
async function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    await ended;
  } finally {
    clearTimeout(timer);
  }
}
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`independent Node CLI worker ${backend} recovers a crashed lease owner and preserves fail-open result`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-worker-process-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    let postgresUrl: string | undefined;
    let admin: PgClient | undefined;
    const databaseName = `forge_process_${crypto.randomUUID().replaceAll("-", "")}`;
    if (backend === "postgres") {
      admin = new PgClient({
        connectionString: process.env.FORGE_TEST_POSTGRES_URL,
      });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(process.env.FORGE_TEST_POSTGRES_URL!);
      url.pathname = `/${databaseName}`;
      postgresUrl = url.toString();
    }
    const storage = await openDatabase({ dataDir, postgresUrl });
    const identities = new IdentityService(storage.db),
      owner = await identities.bootstrapLocal(),
      project = await identities.createProject(owner, "Process recovery");
    const queue = new JobQueue(storage);
    let claimant: ChildProcess | undefined, worker: ChildProcess | undefined;
    try {
      const original =
        "Bu bağımsız süreç kurtarma deneyinde özgün Türkçe isteği ve belirtilen çıktı biçimini aynen koru.";
      const accepted = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: "process-crash",
        payload: { original },
        deadlineMs: 15000,
      });
      const childPath = join(root, "claim.ts");
      await writeFile(
        childPath,
        `import { openDatabase } from ${JSON.stringify(resolve("src/storage/database.ts"))};\nimport { JobQueue } from ${JSON.stringify(resolve("src/jobs/queue.ts"))};\nconst db = await openDatabase({dataDir:${JSON.stringify(dataDir)},postgresUrl:process.env.SKILL_FORGE_POSTGRES_URL});\nconst run = await new JobQueue(db).claim('crash-process',1000,'skill_evolve');\nconsole.log(JSON.stringify({id:run?.id}));\nsetInterval(()=>{},1000);\n`,
      );
      const env = {
        PATH: process.env.PATH,
        SKILL_FORGE_PROFILE: postgresUrl ? "server" : "local",
        SKILL_FORGE_POSTGRES_URL: postgresUrl,
        SKILL_FORGE_PUBLIC_URL: "https://worker-fixture.invalid",
        SKILL_FORGE_OIDC_ISSUER: "https://issuer-fixture.invalid",
        SKILL_FORGE_OIDC_CLIENT_ID: "worker-process-fixture",
        SKILL_FORGE_DATA_DIR: dataDir,
        OC_SKILL_POWER_HOME: join(root, "legacy-home"),
      };
      claimant = spawn(process.execPath, [childPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const claimed = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(Error("Claimant readiness timeout")),
          5000,
        );
        claimant!.once("error", reject);
        claimant!.stdout!.on("data", (chunk) => {
          output += chunk;
          if (output.includes("\n")) {
            clearTimeout(timer);
            resolve(output.trim());
          }
        });
      });
      expect(JSON.parse(claimed).id).toBe(accepted.run.id);
      const stale = await queue.get(owner, accepted.run.id);
      expect(stale.state).toBe("running");
      await stop(claimant, "SIGKILL");
      worker = spawn(
        "node",
        [resolve("dist/cli.js"), "worker", "--data-dir", dataDir],
        { env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let diagnostics = "";
      worker.stderr!.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-2000);
      });
      const deadline = Date.now() + 10000;
      let result = await queue.get(owner, accepted.run.id);
      while (Date.now() < deadline && result.state !== "failed") {
        if (worker.exitCode !== null)
          throw Error(`Worker exited: ${diagnostics}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        result = await queue.get(owner, accepted.run.id);
      }
      expect(result.state).toBe("failed");
      expect(result.error_code).toBe("model_missing");
      expect(result.fence).toBeGreaterThan(stale.fence);
      const lostAttempt = await storage.db
        .selectFrom("run_attempts")
        .selectAll()
        .where("tenant_id", "=", owner.tenantId)
        .where("run_id", "=", accepted.run.id)
        .where("fence", "=", stale.fence)
        .executeTakeFirstOrThrow();
      expect(lostAttempt.ended_at).not.toBeNull();
      expect(lostAttempt.result).toBe("lease_expired");
      const history = await queue.attempts(owner, accepted.run.id);
      expect(history.items.map((item) => item.result)).toEqual([
        "lease_expired",
        "failed",
      ]);
      expect(history.items.every((item) => item.ended_at !== null)).toBe(true);
      expect(JSON.stringify(history)).not.toContain(original);
      expect(
        (await queue.attempts(owner, accepted.run.id, stale.fence)).items,
      ).toHaveLength(1);
      await expect(
        queue.attempts({ ...owner, userId: "other-user" }, accepted.run.id),
      ).rejects.toMatchObject({ code: "run_unavailable" });
      await expect(
        queue.finish(stale, "completed", { overwritten: true }),
      ).rejects.toMatchObject({ code: "stale_worker" });
      const replay = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: "process-crash",
        payload: { original },
      });
      expect(replay.status).toBe("duplicate");
      expect(replay.run.id).toBe(accepted.run.id);
      const prompt = await queue.accept(owner, {
        projectId: project.id,
        kind: "prompt_edit",
        key: "normal-prompt",
        payload: { original },
      });
      let promptResult = await queue.get(owner, prompt.run.id);
      const promptDeadline = Date.now() + 5000;
      while (Date.now() < promptDeadline && promptResult.state !== "fallback") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        promptResult = await queue.get(owner, prompt.run.id);
      }
      expect(promptResult.state).toBe("fallback");
      expect(JSON.parse(promptResult.result_json!)).toMatchObject({
        original,
        effective: original,
        auto_applied: false,
        reason: "model_missing",
      });
      await stop(worker, "SIGTERM");
      expect(worker.exitCode).toBe(0);
    } finally {
      if (claimant) await stop(claimant, "SIGKILL");
      if (worker) await stop(worker, "SIGTERM");
      await storage.close();
      if (admin) {
        try {
          await admin.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await admin.end();
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 35000);
}
