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
import { CursorCodec } from "../src/application/cursor.js";
test("official MCP: only six tools, real daemon worker, prompt fail-open, durable handoff and report", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-mcp-")),
    config = await localConfig(root),
    app = await createHttpServer(config);
  const client = new Client({ name: "six-tool-contract", version: "1" });
  try {
    await app.listen({ host: config.host, port: config.port });
    const headers = {
      host: new URL(config.url).host,
      authorization: `Bearer ${config.token}`,
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "MCP acceptance" },
    });
    const project = response.json();
    expect(response.statusCode).toBe(200);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${config.url}/mcp`), {
        requestInit: { headers },
      }),
    );
    const names = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([
      "forge_handoff",
      "forge_load",
      "forge_prepare",
      "forge_report",
      "forge_run",
      "forge_search",
    ]);
    const invoke = async (name: string, args: object) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    expect(
      (await invoke("forge_search", { project_ref: project.id, query: "" }))
        .items,
    ).toEqual([]);
    const original = "Yalnız bu dosyada 3 satırı düzelt, sürümü değiştirme.";
    const prepared = await invoke("forge_prepare", {
      project_ref: project.id,
      original,
      idempotency_key: "prepare-once",
    });
    expect(prepared.status).toBe("fallback");
    expect(prepared.reason).toBe("model_missing");
    expect(prepared.effective).toBe(original);
    const args = {
      project_ref: project.id,
      summary: "Real storage test passed; reusable recovery method.",
      idempotency_key: "handoff-once",
      source: { client: "contract" },
      evidence: [
        {
          kind: "test",
          summary: "SQLite reopen and immutable prior revision tested.",
        },
      ],
    };
    const accepted = await invoke("forge_handoff", args);
    expect(accepted.status).toBe("accepted");
    const duplicate = await invoke("forge_handoff", args);
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.run_id).toBe(accepted.run_id);
    let report;
    for (let i = 0; i < 50; i++) {
      report = await invoke("forge_report", {
        project_ref: project.id,
        run_id: accepted.run_id,
      });
      if (report.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(report.status).toBe("failed");
    expect(report.error_code).toBe("model_missing");
    expect(report).not.toHaveProperty("config_json");
    const denied = await client.callTool({
      name: "forge_search",
      arguments: { project_ref: "other-tenant-project" },
    });
    expect(denied.isError).toBe(true);
  } finally {
    await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
test("opaque cursors reject modifications and cross-user/query reuse", () => {
  const codec = new CursorCodec("test-only-signing-key"),
    token = codec.encode(["user", "query"], "next");
  expect(codec.decode(token, ["user", "query"])).toBe("next");
  expect(() => codec.decode(token, ["other", "query"])).toThrow();
  expect(() => codec.decode(token + "x", ["user", "query"])).toThrow();
});
