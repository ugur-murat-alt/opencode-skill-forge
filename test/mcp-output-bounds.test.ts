import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { ForgeService } from "../src/application/forge.js";
import { PackageStore } from "../src/skills/store.js";
import { DockerExecutor } from "../src/execution/docker.js";
test("real script large JSON is an artifact, pages preserve UTF-8 and ledger replay, scope and inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-output-bounds-")),
    storage = await openDatabase({ dataDir: root });
  try {
    const identity = new IdentityService(storage.db),
      actor = await identity.bootstrapLocal(),
      project = await identity.createProject(actor, "Output bounds"),
      other = await identity.createProject(actor, "Foreign project");
    const forge = new ForgeService(storage, root, "bound-test-key"),
      store = new PackageStore(storage, root, (path, manifest) =>
        new DockerExecutor(root).validate(path, manifest),
      );
    const files: Record<string, Buffer> = {
      "SKILL.md": Buffer.from(
        "---\nname: output-bounds\ndescription: Generate bounded UTF-8 output and artifacts for protocol acceptance.\n---\nUse the generate entry.\n",
      ),
      "scripts/generate.js": Buffer.from(
        "import fs from 'node:fs';const {count}=JSON.parse(fs.readFileSync(0,'utf8'));for(let i=0;i<30;i++)fs.writeFileSync('/output/file-'+i+'.txt',String(i));console.log(JSON.stringify({payload:'ğ🙂'.repeat(count)}));",
      ),
      "forge.json": Buffer.from(
        JSON.stringify({
          version: 1,
          entrypoints: {
            generate: {
              runtime: "node",
              path: "scripts/generate.js",
              maxOutputBytes: 100000,
              inputSchema: {
                type: "object",
                properties: {
                  count: { type: "integer", minimum: 1, maximum: 5000 },
                },
                required: ["count"],
              },
              outputSchema: {
                type: "object",
                properties: { payload: { type: "string" } },
                required: ["payload"],
              },
              tests: [
                {
                  name: "small",
                  input: { count: 1 },
                  expected: { payload: "ğ🙂" },
                },
              ],
            },
          },
        }),
      ),
    };
    for (let i = 0; i < 87; i++)
      files[`assets/file-${i}.txt`] = Buffer.from(`asset ${i}`);
    const published = await store.publish(actor, {
      name: "output-bounds",
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files,
    });
    const pin = {
      project_ref: project.id,
      skill_id: published.skill_id,
      revision: published.revision,
    };
    let cursor: string | undefined,
      inventory: string[] = [];
    do {
      const page = await forge.invoke("forge_load", actor, {
        ...pin,
        inventory: true,
        cursor,
      });
      expect(page.content).toBeUndefined();
      expect(page.files.length).toBeLessThanOrEqual(40);
      inventory.push(...page.files.map((f: any) => f.path));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(inventory).toHaveLength(90);
    expect(new Set(inventory).size).toBe(90);
    const args = {
      ...pin,
      entrypoint: "generate",
      args: { count: 5000 },
      idempotency_key: "bounded-result-once",
    };
    const result = await forge.invoke("forge_run", actor, args);
    expect(result.status).toBe("completed");
    expect(result.result).toBeUndefined();
    expect(result.result_truncated).toBe(true);
    expect(result.artifact_count).toBe(31);
    expect(result.artifacts.length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16384);
    expect(JSON.stringify(result)).not.toContain("sandbox_execution_id");
    let artifacts = [...result.artifacts];
    cursor = result.next_cursor;
    while (cursor) {
      const page = await forge.invoke("forge_report", actor, {
        project_ref: project.id,
        section: "execution",
        execution_id: result.execution_id,
        cursor,
      });
      artifacts.push(...page.artifacts);
      cursor = page.next_cursor;
    }
    expect(artifacts).toHaveLength(31);
    expect(new Set(artifacts.map((a) => a.path)).size).toBe(31);
    const fullResult = artifacts.find(
      (a) => a.path === result.result_artifact_path,
    )!;
    let text = "";
    cursor = undefined;
    do {
      const chunk = await forge.invoke("forge_report", actor, {
        project_ref: project.id,
        section: "execution",
        execution_id: result.execution_id,
        artifact_reference: fullResult.reference,
        cursor,
      });
      expect(chunk.encoding).toBe("utf8");
      expect(chunk.bytes).toBeLessThanOrEqual(24576);
      text += chunk.content;
      cursor = chunk.next_cursor;
    } while (cursor);
    expect(JSON.parse(text)).toEqual({ payload: "ğ🙂".repeat(5000) });
    const replay = await forge.invoke("forge_run", actor, args);
    expect(replay.execution_id).toBe(result.execution_id);
    expect(replay.artifacts[0].reference).not.toBe(
      result.artifacts[0].reference,
    );
    const stored = await storage.db
      .selectFrom("executions")
      .select("result_json")
      .where("id", "=", result.execution_id)
      .executeTakeFirstOrThrow();
    expect(stored.result_json).not.toContain("ğ🙂");
    await storage.db
      .updateTable("executions")
      .set({
        result_json: JSON.stringify({
          execution_id: result.execution_id,
          status: "completed",
          result: { historical: "x".repeat(30000) },
          artifacts: [],
        }),
      })
      .where("id", "=", result.execution_id)
      .execute();
    const historical = await forge.invoke("forge_report", actor, {
      project_ref: project.id,
      section: "execution",
      execution_id: result.execution_id,
    });
    expect(historical.result_truncated).toBe(true);
    expect(historical.result).toBeUndefined();
    const historicalFirst = await forge.invoke("forge_report", actor, {
      project_ref: project.id,
      section: "execution",
      execution_id: result.execution_id,
      result_content: true,
    });
    const historicalLast = await forge.invoke("forge_report", actor, {
      project_ref: project.id,
      section: "execution",
      execution_id: result.execution_id,
      result_content: true,
      cursor: historicalFirst.next_cursor,
    });
    expect(
      JSON.parse(historicalFirst.content + historicalLast.content),
    ).toEqual({ historical: "x".repeat(30000) });

    await expect(
      forge.invoke("forge_report", actor, {
        project_ref: other.id,
        section: "execution",
        execution_id: result.execution_id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      forge.invoke("forge_report", actor, {
        project_ref: project.id,
        section: "execution",
        execution_id: result.execution_id,
        artifact_reference: fullResult.reference + "altered",
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("artifact metadata response stays bounded for long Unicode paths and large historical JSON", async () => {
  const { executionPage } =
    await import("../src/application/execution-results.js");
  const { CursorCodec } = await import("../src/application/cursor.js");
  const codec = new CursorCodec("test-only"),
    actor = { tenantId: "tenant", userId: "user" };
  const stored = {
    format_version: 2 as const,
    execution_id: crypto.randomUUID(),
    sandbox_execution_id: crypto.randomUUID(),
    status: "completed" as const,
    result: { payload: "x".repeat(8000) },
    artifacts: Array.from({ length: 100 }, (_, i) => ({
      path: `${"ğ".repeat(180)}-${i}.txt`,
      bytes: 20,
    })),
  };
  let cursor: string | undefined,
    paths: string[] = [];
  do {
    const page = executionPage(codec, actor, "project", stored, 20, cursor);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16384);
    paths.push(...page.artifacts.map((a) => a.path));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(new Set(paths).size).toBe(100);
  const old = executionPage(codec, actor, "project", {
    ...stored,
    format_version: undefined,
    sandbox_execution_id: undefined,
    result: { historical: "x".repeat(30000) },
    artifacts: [],
  });
  expect(old.result).toBeUndefined();
  expect(old.result_truncated).toBe(true);
  expect(old.result_content_available).toBe(true);
});

test("job lists omit private result bodies; chunk cursors reject changed result snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-job-bounds-")),
    storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db),
      actor = await identities.bootstrapLocal(),
      project = await identities.createProject(actor, "Job bounds"),
      forge = new ForgeService(storage, root, "test-key");
    const accepted = await forge.queue.accept(actor, {
      projectId: project.id,
      kind: "prompt_edit",
      key: "large-private-result",
      payload: { original: "Small input" },
    });
    const result = {
      status: "improved",
      original: "private-result-canary".repeat(3000),
      effective: "private-result-canary".repeat(3000),
      usage: { calls: 1, tokens: 45, cost_micros: null, elapsed_ms: 100 },
    };
    await storage.db
      .updateTable("runs")
      .set({ state: "improved", result_json: JSON.stringify(result) })
      .where("id", "=", accepted.run.id)
      .execute();
    const list = await forge.invoke("forge_report", actor, {
      project_ref: project.id,
    });
    expect(JSON.stringify(list)).not.toContain("private-result-canary");
    expect(list.items[0].result_summary.usage.cost_micros).toBeNull();
    const detail = await forge.invoke("forge_report", actor, {
      project_ref: project.id,
      run_id: accepted.run.id,
    });
    expect(detail.result).toBeUndefined();
    expect(detail.result_truncated).toBe(true);
    const first = await forge.invoke("forge_report", actor, {
      project_ref: project.id,
      run_id: accepted.run.id,
      result_content: true,
    });
    expect(first.bytes).toBeLessThanOrEqual(24576);
    expect(first.next_cursor).toBeTruthy();
    let text = first.content,
      cursor = first.next_cursor;
    while (cursor) {
      const next = await forge.invoke("forge_report", actor, {
        project_ref: project.id,
        run_id: accepted.run.id,
        result_content: true,
        cursor,
      });
      text += next.content;
      cursor = next.next_cursor;
    }
    expect(JSON.parse(text)).toEqual(result);
    await storage.db
      .updateTable("runs")
      .set({
        result_json: JSON.stringify({
          status: "improved",
          content_expired: true,
        }),
      })
      .where("id", "=", accepted.run.id)
      .execute();
    await expect(
      forge.invoke("forge_report", actor, {
        project_ref: project.id,
        run_id: accepted.run.id,
        result_content: true,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
