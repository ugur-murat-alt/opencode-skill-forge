import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { ForgeService } from "../src/application/forge.js";
import { PackageStore } from "../src/skills/store.js";
import { DockerExecutor } from "../src/execution/docker.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`execution revision pin ${backend}: real sandbox, FK protection, completion/failure and replay`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-execution-pin-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    let pending: Promise<unknown> | undefined;
    try {
      const auth = new IdentityService(storage.db),
        actor = await auth.bootstrapLocal();
      const project = await auth.createProject(actor, "Execution pin");
      const docker = new DockerExecutor(root),
        packages = new PackageStore(storage, root, (path, manifest) =>
          docker.validate(path, manifest),
        );
      const name = `pin-${crypto.randomUUID()}`;
      const published = await packages.publish(actor, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Revision korunmasını gerçek script ile doğrular.\n---\n# Yöntem\nJSON girdisini okuyup gecikmeden sonra sonuç döndürür.\n`,
          ),
          "scripts/main.js": Buffer.from(
            'let s="";for await (const b of process.stdin)s+=b;const x=JSON.parse(s);await new Promise(r=>setTimeout(r,x.delay));console.log(JSON.stringify({ok:true}));',
          ),
          "forge.json": Buffer.from(
            JSON.stringify({
              version: 1,
              entrypoints: {
                wait: {
                  runtime: "node",
                  path: "scripts/main.js",
                  inputSchema: {
                    type: "object",
                    properties: { delay: { type: "number" } },
                    required: ["delay"],
                    additionalProperties: false,
                  },
                  outputSchema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                    required: ["ok"],
                    additionalProperties: false,
                  },
                  timeoutMs: 8000,
                  tests: [
                    {
                      name: "ready",
                      input: { delay: 0 },
                      expected: { ok: true },
                    },
                  ],
                },
              },
            }),
          ),
        },
      });
      const forge = new ForgeService(storage, root, "fixture-pin-key");
      const input = {
        project_ref: project.id,
        skill_id: published.skill_id,
        revision: published.revision,
        entrypoint: "wait",
        args: { delay: 1800 },
        idempotency_key: crypto.randomUUID(),
      };
      pending = forge.invoke("forge_run", actor, input);
      const pins = () =>
        storage.db
          .selectFrom("execution_revision_pins")
          .selectAll()
          .where("tenant_id", "=", actor.tenantId)
          .where("skill_id", "=", published.skill_id)
          .execute();
      let rows = await pins();
      const deadline = Date.now() + 5000;
      while (!rows.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
        rows = await pins();
      }
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revision).toBe(published.revision);
      expect((await forge.invoke("forge_run", actor, input)).status).toBe(
        "running_or_unknown",
      );
      // Remove only the active-pointer guard within a rolled-back transaction, isolating the pin FK.
      await expect(
        storage.db.transaction().execute(async (tx) => {
          await tx
            .updateTable("skills")
            .set({ active_revision: null })
            .where("tenant_id", "=", actor.tenantId)
            .where("id", "=", published.skill_id)
            .execute();
          await tx
            .deleteFrom("skill_revisions")
            .where("tenant_id", "=", actor.tenantId)
            .where("skill_id", "=", published.skill_id)
            .where("revision", "=", published.revision)
            .execute();
        }),
      ).rejects.toThrow();
      const result = (await pending) as {
        status: string;
        execution_id: string;
      };
      expect(result.status).toBe("completed");
      expect(await pins()).toHaveLength(0);
      expect((await forge.invoke("forge_run", actor, input)).execution_id).toBe(
        result.execution_id,
      );
      expect(await pins()).toHaveLength(0);
      const failed = await forge.invoke("forge_run", actor, {
        ...input,
        entrypoint: "missing",
        idempotency_key: crypto.randomUUID(),
      });
      expect(failed.status).toBe("failed");
      expect(await pins()).toHaveLength(0);
    } finally {
      await pending?.catch(() => undefined);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
}
