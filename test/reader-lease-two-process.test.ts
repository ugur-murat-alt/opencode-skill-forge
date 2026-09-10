import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { MaintenanceService } from "../src/application/maintenance.js";
import { DeletionService } from "../src/application/deletion.js";

const childScript = new URL("./file-lifecycle-child.ts", import.meta.url)
  .pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await sleep(20);
    }
  }
  return null;
}

test.skipIf(process.platform !== "linux")(
  "P2 #27 two-process long read with a stopped heartbeat: deletion completes and the reader cannot accept data",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-lease-process-"));
    const storage = await openDatabase({ dataDir: root });
    let child: ChildProcess | undefined;
    try {
      const actor = await new IdentityService(storage.db).bootstrapLocal();
      const project = await new IdentityService(storage.db).createProject(
        actor,
        "Two process lease",
      );
      const store = new PackageStore(
        storage,
        root,
        undefined,
        {},
        {
          leaseMs: 300,
        },
      );
      const name = `two-process-${randomUUID().slice(0, 8)}`;
      const pkg = await store.publish(actor, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Paused heartbeat deletion acceptance.\n---\nBody.\n`,
          ),
        },
      });
      const loaded = await store.files(actor, pkg.skill_id, pkg.revision);
      await new MaintenanceService(storage, root).apply(actor, {
        project_ref: project.id,
        operation_id: randomUUID(),
        action: "archive",
        items: [
          {
            skill_id: pkg.skill_id,
            revision: pkg.revision,
            updated_at: loaded.skill.updated_at,
          },
        ],
      });
      const archived = await store.authorizedSkill(actor, pkg.skill_id);
      const marker = join(root, "holding.marker");
      const releaseFile = join(root, "release.marker");
      const resultFile = join(root, "child-result.json");
      child = spawn(process.execPath, [childScript, "hold-read"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          FORGE_TEST_ROOT: root,
          FORGE_TEST_RESULT: resultFile,
          FORGE_TEST_SKILL: pkg.skill_id,
          FORGE_TEST_REVISION: pkg.revision,
          FORGE_TEST_MARKER: marker,
          FORGE_TEST_RELEASE: releaseFile,
          FORGE_TEST_LEASE_MS: "300",
        },
      });
      expect(await waitForFile(marker, 5_000)).toBe("holding");
      const pin = await storage.db
        .selectFrom("revision_readers")
        .selectAll()
        .where("tenant_id", "=", actor.tenantId)
        .executeTakeFirstOrThrow();
      expect(pin.kind).toBe("read");
      expect(pin.owner).not.toBeNull();
      const deletion = new DeletionService(storage, root);
      const input = {
        project_ref: project.id,
        operation_id: randomUUID(),
        action: "delete" as const,
        items: [
          {
            skill_id: pkg.skill_id,
            revision: pkg.revision,
            updated_at: archived.updated_at,
          },
        ],
      };
      // Canlı pin silmeyi engeller.
      const blocked = await deletion.preview(actor, input);
      expect(blocked.items[0]).toMatchObject({
        status: "blocked",
        error: { code: "skill_referenced" },
      });
      // Heartbeat duraklatılır: SIGSTOP süreç gerçekten donar.
      child.kill("SIGSTOP");
      await sleep(800);
      const swept = await store.reconcile(actor);
      expect(swept.cleared_readers).toBeGreaterThanOrEqual(1);
      // Lease kaybı silmeyi artık engellemez ve dosyalar güvenle kaldırılır.
      const applied = await deletion.apply(actor, input);
      expect(applied.items[0]).toMatchObject({ status: "completed" });
      await expect(access(loaded.path)).rejects.toThrow();
      // Okuyucu serbest bırakılır; sonuç kabul edilmez.
      await writeFile(releaseFile, "release");
      const diagnostics: string[] = [];
      child.stdout?.on("data", (chunk) => diagnostics.push(String(chunk)));
      child.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));
      child.kill("SIGCONT");
      const exited = await Promise.race([
        once(child, "exit").then(([code]) => ({ code })),
        sleep(10_000).then(() => ({ code: -1 as number })),
      ]);
      if (exited.code === -1) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        await once(child, "exit");
        throw new Error(`Alt süreç çıkmadı: ${diagnostics.join("")}`);
      }
      expect(exited.code).toBe(0);
      const result = JSON.parse((await readFile(resultFile, "utf8")) as string);
      expect(result).toMatchObject({ ok: false, code: "reader_closed" });
      child = undefined;
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
