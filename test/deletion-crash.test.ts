import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { MaintenanceService } from "../src/application/maintenance.js";

test.skipIf(process.platform !== "linux")(
  "Node HTTP deletion survives SIGKILL during real file cleanup",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-delete-crash-"));
    const storage = await openDatabase({ dataDir: root });
    let child: ReturnType<typeof spawn> | undefined;
    let response: Promise<unknown> | undefined;
    try {
      const actor = await new IdentityService(storage.db).bootstrapLocal();
      const project = await new IdentityService(storage.db).createProject(
        actor,
        "Crash cleanup",
      );
      const store = new PackageStore(storage, root);
      const pkg = await store.publish(actor, {
        name: "crash-cleanup",
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: {
          "SKILL.md": Buffer.from(
            "---\nname: crash-cleanup\ndescription: Gerçek dosya temizliği kesintisi kabul paketi.\n---\n# Kontrol\nKesintiden sonra temizliği tamamla.\n",
          ),
        },
      });
      const loaded = await store.files(actor, pkg.skill_id, pkg.revision);
      await new MaintenanceService(storage, root).apply(actor, {
        project_ref: project.id,
        operation_id: crypto.randomUUID(),
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
      const listener = createServer();
      await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((r) => listener.close(() => r()));
      const url = `http://127.0.0.1:${port}`;
      async function start() {
        child = spawn(
          "node",
          [
            resolve("dist/cli.js"),
            "serve",
            "--data-dir",
            root,
            "--port",
            String(port),
          ],
          {
            stdio: "ignore",
            env: {
              PATH: process.env.PATH,
              SKILL_FORGE_PROFILE: "local",
              SKILL_FORGE_DATA_DIR: root,
              OC_SKILL_POWER_HOME: join(root, "legacy"),
            },
          },
        );
        for (let i = 0; i < 300; i++) {
          if (child.exitCode !== null)
            throw Error("Owned server exited before readiness");
          try {
            if (
              (
                await fetch(url + "/health/ready", {
                  signal: AbortSignal.timeout(250),
                })
              ).ok
            )
              return;
          } catch {}
          await new Promise((r) => setTimeout(r, 20));
        }
        throw Error("Owned server readiness timeout");
      }
      await start();
      const token = (await readFile(join(root, "owner-token"), "utf8")).trim();
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      // Extra abandoned files exercise recursive GC without enlarging the published manifest.
      // No test hook or delay is installed in production deletion code.
      for (let batch = 0; batch < 80; batch++)
        await Promise.all(
          Array.from({ length: 100 }, (_, i) =>
            writeFile(
              join(loaded.path, `orphan-${batch * 100 + i}`),
              "cleanup",
            ),
          ),
        );
      const initial = (await readdir(loaded.path)).length;
      const body = {
        project_ref: project.id,
        operation_id: crypto.randomUUID(),
        action: "delete",
        items: [
          {
            skill_id: pkg.skill_id,
            revision: pkg.revision,
            updated_at: archived.updated_at,
          },
        ],
      };
      response = fetch(url + "/api/maintenance/apply", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
        .then((r) => r.json())
        .catch(() => null);
      let partial = false;
      for (let i = 0; i < 1000; i++) {
        const count = (await readdir(loaded.path)).length;
        if (count > 0 && count < initial) {
          partial = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
      expect(partial).toBe(true);
      const exited = once(child!, "exit");
      child!.kill("SIGKILL");
      expect((await exited)[1]).toBe("SIGKILL");
      await response;
      expect((await readdir(loaded.path)).length).toBeGreaterThan(0);
      expect(
        await storage.db
          .selectFrom("skills")
          .select("id")
          .where("id", "=", pkg.skill_id)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await storage.db
          .selectFrom("package_gc")
          .select("state")
          .where("skill_id", "=", pkg.skill_id)
          .executeTakeFirst(),
      ).toMatchObject({ state: "pending" });
      await start();
      const pending = (await fetch(
        url + "/api/maintenance/deletions?project_ref=" + project.id,
        { headers },
      ).then((r) => r.json())) as { items: { skill_id: string }[] };
      expect(pending.items.map((i) => i.skill_id)).toContain(pkg.skill_id);
      const resumed = await fetch(url + "/api/maintenance/deletions/resume", {
        method: "POST",
        headers,
        body: JSON.stringify({
          project_ref: project.id,
          skill_id: pkg.skill_id,
        }),
      });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ status: "completed" });
      await expect(access(loaded.path)).rejects.toThrow();
      const replay = (await fetch(url + "/api/maintenance/apply", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }).then((r) => r.json())) as { items: unknown[] };
      expect(replay.items[0]).toMatchObject({ status: "completed" });
      expect(
        await storage.db
          .selectFrom("audit_events")
          .select("id")
          .where("kind", "=", "maintenance.delete")
          .execute(),
      ).toHaveLength(1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await response;
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
