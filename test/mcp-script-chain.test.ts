import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { exportPackage } from "../src/skills/archive.js";
test("real MCP search/load/reference/run pinned TypeScript package with immutable rollback and artifact ACL", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-chain-")),
    config = await localConfig(root),
    app = await createHttpServer(config);
  const client = new Client({ name: "real-script-chain", version: "1" });
  try {
    await app.listen({ host: config.host, port: config.port });
    const headers = {
      host: new URL(config.url).host,
      authorization: `Bearer ${config.token}`,
    };
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "Script chain" },
      })
    ).json();
    const files = {
      "SKILL.md": Buffer.from(
        "---\nname: bounded-double\ndescription: Double a numeric JSON value with a registered TypeScript helper.\n---\n[Input guide](references/input.md)\nUse the double entry.\n",
      ),
      "references/input.md": Buffer.from(
        "Input is an object with numeric x. Output contains doubled value.",
      ),
      "scripts/double.ts": Buffer.from(
        "import fs from 'node:fs';const input: {x:number}=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync('/output/value.txt',String(input.x*2));console.log(JSON.stringify({value:input.x*2}));",
      ),
      "forge.json": Buffer.from(
        JSON.stringify({
          version: 1,
          entrypoints: {
            double: {
              runtime: "typescript",
              path: "scripts/double.ts",
              idempotent: true,
              inputSchema: {
                type: "object",
                properties: { x: { type: "number" } },
                required: ["x"],
                additionalProperties: false,
              },
              outputSchema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
              },
              tests: [
                { name: "double", input: { x: 4 }, expected: { value: 8 } },
              ],
            },
          },
        }),
      ),
    };
    const imported = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      headers,
      payload: {
        project_ref: project.id,
        scope: "project",
        archive: exportPackage("bounded-double", files).toString("base64"),
      },
    });
    expect(imported.statusCode).toBe(200);
    const published = imported.json();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${config.url}/mcp`), {
        requestInit: { headers },
      }),
    );
    let toolCalls = 0;
    const invoke = async (name: string, args: object) => {
      toolCalls++;
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toBeUndefined();
      return JSON.parse((response.content as { text: string }[])[0]!.text);
    };
    const matches = await invoke("forge_search", {
      project_ref: project.id,
      query: "numeric",
    });
    expect(matches.items[0].revision).toBe(published.revision);
    const pinned = {
      project_ref: project.id,
      skill_id: published.skill_id,
      revision: published.revision,
    };
    expect((await invoke("forge_load", pinned)).content).toContain(
      "references/input.md",
    );
    expect(
      (await invoke("forge_load", { ...pinned, path: "references/input.md" }))
        .content,
    ).toContain("numeric x");
    const args = {
      ...pinned,
      entrypoint: "double",
      args: { x: 7 },
      idempotency_key: "execute-once",
    };
    const result = await invoke("forge_run", args);
    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ value: 14 });
    expect(toolCalls).toBe(4);
    const duplicate = await invoke("forge_run", args);
    expect(duplicate.execution_id).toBe(result.execution_id);
    const artifactUrl = `/api/artifacts/${result.execution_id}?reference=${encodeURIComponent(result.artifacts[0].reference)}`;
    const artifact = await app.inject({ url: artifactUrl, headers });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.body).toBe("14");
    expect(
      (await app.inject({ url: artifactUrl, headers: { host: headers.host } }))
        .statusCode,
    ).toBe(401);
    const changed = {
      ...files,
      "references/input.md": Buffer.from(
        "Input is an object with numeric x. It can be fractional.",
      ),
    };
    const update = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      headers,
      payload: {
        project_ref: project.id,
        scope: "project",
        base_revision: published.revision,
        archive: exportPackage("bounded-double", changed).toString("base64"),
      },
    });
    expect(update.statusCode).toBe(200);
    const rollback = await app.inject({
      method: "POST",
      url: `/api/skills/${published.skill_id}/rollback`,
      headers,
      payload: {
        target_revision: published.revision,
        base_revision: update.json().revision,
      },
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().revision).toBe(published.revision);
    const inventory = await app.inject({
      url: `/api/skills/${published.skill_id}/manifest?revision=${published.revision}`,
      headers,
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().execution.entrypoints.double.runtime).toBe(
      "typescript",
    );
    const scriptHash = inventory
      .json()
      .files.find((f: any) => f.path === "scripts/double.ts").hash;
    const broken = await app.inject({
      method: "POST",
      url: `/api/skills/${published.skill_id}/edit`,
      headers,
      payload: {
        base_revision: published.revision,
        changes: [
          {
            path: "scripts/double.ts",
            original_hash: scriptHash,
            content: files["scripts/double.ts"]
              .toString()
              .replaceAll("input.x*2", "input.x*3"),
          },
        ],
      },
    });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error.code).toBe("candidate_tests_failed");
    const afterFailure = await invoke("forge_search", {
      project_ref: project.id,
      query: "numeric",
    });
    expect(afterFailure.items[0].revision).toBe(published.revision);
    const referenceHash = inventory
      .json()
      .files.find((f: any) => f.path === "references/input.md").hash;
    const edited = await app.inject({
      method: "POST",
      url: `/api/skills/${published.skill_id}/edit`,
      headers,
      payload: {
        base_revision: published.revision,
        changes: [
          {
            path: "references/input.md",
            original_hash: referenceHash,
            content:
              "Numeric x, including fractions. Preserve the output schema.",
          },
        ],
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().revision).not.toBe(published.revision);
    const stale = await app.inject({
      method: "POST",
      url: `/api/skills/${published.skill_id}/edit`,
      headers,
      payload: {
        base_revision: published.revision,
        changes: [
          {
            path: "references/input.md",
            original_hash: referenceHash,
            content: "Stale overwrite",
          },
        ],
      },
    });
    expect(stale.statusCode).toBe(409);
    const exported = await app.inject({
      url: `/api/skills/${published.skill_id}/export?revision=${published.revision}`,
      headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/zip");
  } finally {
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
