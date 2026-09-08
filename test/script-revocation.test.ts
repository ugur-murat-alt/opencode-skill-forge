import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
import { ForgeService } from "../src/application/forge.js";
import { PackageStore } from "../src/skills/store.js";
import { DockerExecutor } from "../src/execution/docker.js";
test("real sandbox execution aborts on membership revocation and preserves its failed receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-script-revoke-")),
    storage = await openDatabase({ dataDir: root });
  try {
    const identity = new IdentityService(storage.db),
      owner = await identity.bootstrapLocal(),
      project = await identity.createProject(owner, "Script revoke"),
      members = new MemberService(storage.db);
    const user = await members.create(owner, {
      subject: "revoke-fixture",
      display_name: "Revoke fixture",
      role: "writer",
    });
    await members.update(owner, user.user_id, {
      project_ref: project.id,
      generation: 0,
      project_generation: null,
      role: "writer",
      disabled: false,
      project_role: "writer",
    });
    const actor = { ...owner, userId: user.user_id },
      forge = new ForgeService(storage, root, "test-key"),
      store = new PackageStore(storage, root, (path, manifest) =>
        new DockerExecutor(root).validate(path, manifest),
      );
    const files = {
      "SKILL.md": Buffer.from(
        "---\nname: revoke-fixture\ndescription: Bounded delayed JSON helper for revocation acceptance.\n---\nUse the wait entry.\n",
      ),
      "scripts/wait.js": Buffer.from(
        "import fs from 'node:fs';const {wait}=JSON.parse(fs.readFileSync(0,'utf8'));await new Promise(r=>setTimeout(r,wait?8000:0));console.log(JSON.stringify({ok:true}));",
      ),
      "forge.json": Buffer.from(
        JSON.stringify({
          version: 1,
          entrypoints: {
            wait: {
              runtime: "node",
              path: "scripts/wait.js",
              timeoutMs: 10000,
              inputSchema: {
                type: "object",
                properties: { wait: { type: "boolean" } },
                required: ["wait"],
              },
              outputSchema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
              },
              tests: [
                {
                  name: "quick",
                  input: { wait: false },
                  expected: { ok: true },
                },
              ],
            },
          },
        }),
      ),
    };
    const published = await store.publish(owner, {
      name: "revoke-fixture",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files,
    });
    const start = Date.now();
    const running = forge.invoke("forge_run", actor, {
      project_ref: project.id,
      skill_id: published.skill_id,
      revision: published.revision,
      entrypoint: "wait",
      args: { wait: true },
      idempotency_key: "revoke-once",
    });
    // Let the real sandbox enter its bounded wait, then revoke the running actor.
    await new Promise((r) => setTimeout(r, 1500));
    await members.update(owner, user.user_id, {
      project_ref: project.id,
      generation: 1,
      project_generation: 0,
      role: "writer",
      disabled: true,
      project_role: "writer",
    });
    const result = await running;
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("permission_revoked");
    expect(Date.now() - start).toBeLessThan(6500);
    const ledger = await storage.db
      .selectFrom("executions")
      .selectAll()
      .where("user_id", "=", actor.userId)
      .executeTakeFirstOrThrow();
    expect(ledger.state).toBe("failed");
    expect(JSON.parse(ledger.result_json!).error.code).toBe(
      "permission_revoked",
    );
    await members.update(owner, user.user_id, {
      project_ref: project.id,
      generation: 2,
      project_generation: 1,
      role: "writer",
      disabled: false,
      project_role: "writer",
    });
    const duplicate = await forge.invoke("forge_run", actor, {
      project_ref: project.id,
      skill_id: published.skill_id,
      revision: published.revision,
      entrypoint: "wait",
      args: { wait: true },
      idempotency_key: "revoke-once",
    });
    expect(duplicate.execution_id).toBe(result.execution_id);
    expect(duplicate.status).toBe("failed");
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
