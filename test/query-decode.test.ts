import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeQueryToolInput } from "../src/http/query-decode.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";

test("P2 #10 GET query decoding resolves explicit booleans and numbers", () => {
  const decoded = decodeQueryToolInput({
    limit: "20",
    observation_days: "30",
    result_content: "true",
    inventory: "false",
    state: "queued",
  });
  expect(decoded).toEqual({
    limit: 20,
    observation_days: 30,
    result_content: true,
    inventory: false,
    state: "queued",
  });
  // JavaScript truthiness must not turn "false" into true.
  expect(decoded.inventory).toBe(false);
  // Non-numeric and non-boolean strings pass through untouched so the typed
  // MCP schema rejects them with its own validation error.
  expect(decodeQueryToolInput({ limit: "abc" }).limit).toBe("abc");
  expect(decodeQueryToolInput({ result_content: "maybe" }).result_content).toBe(
    "maybe",
  );
  expect(decodeQueryToolInput({ limit: "" }).limit).toBe("");
});

async function login(app: Awaited<ReturnType<typeof createHttpServer>>) {
  const cfg = (app as unknown as { cfg: never }) ?? undefined;
  void cfg;
  return app;
}
void login;

test("P2 #10 GET tool routes accept typed values like the JSON tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-query-"));
  const cfg = await localConfig(root);
  const app = await createHttpServer(cfg);
  try {
    const base = { host: new URL(cfg.url).host, origin: cfg.url };
    const issued = await app.inject({
      method: "POST",
      url: "/api/pairing",
      headers: { ...base, authorization: `Bearer ${cfg.token}` },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/pair",
      headers: base,
      payload: { code: issued.json().code },
    });
    const cookie = loginRes.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const headers = { ...base, cookie, "x-forge-csrf": loginRes.json().csrf };
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "Query types" },
    });
    expect(project.statusCode).toBe(200);
    const projectId = project.json().id;
    const valid = await app.inject({
      url: `/api/skills?project_ref=${projectId}&limit=20`,
      headers,
    });
    expect(valid.statusCode).toBe(200);
    expect(Array.isArray(valid.json().items)).toBe(true);
    const runs = await app.inject({
      url: `/api/runs?project_ref=${projectId}&observation_days=30&limit=3`,
      headers,
    });
    expect(runs.statusCode, runs.body).toBe(200);
    expect(Array.isArray(runs.json().items)).toBe(true);
    // Sınırlar korunur: aşırı limit, sayı olmayan, bozuk boolean, bilinmeyen alan.
    const over = await app.inject({
      url: `/api/skills?project_ref=${projectId}&limit=21`,
      headers,
    });
    expect(over.statusCode, over.body).toBe(400);
    const nan = await app.inject({
      url: `/api/skills?project_ref=${projectId}&limit=abc`,
      headers,
    });
    expect(nan.statusCode, nan.body).toBe(400);
    const badBool = await app.inject({
      url: `/api/runs?project_ref=${projectId}&result_content=maybe&run_id=fake-run`,
      headers,
    });
    expect(badBool.statusCode, badBool.body).toBe(400);
    const unknown = await app.inject({
      url: `/api/skills?project_ref=${projectId}&nonsense=1`,
      headers,
    });
    expect(unknown.statusCode, unknown.body).toBe(400);
    // Tekrarlı anahtar belirsizdir: şema net 400 ile reddeder (sessiz
    // son-değer seçimi yerine).
    const repeated = await app.inject({
      url: `/api/skills?project_ref=${projectId}&limit=1&limit=2`,
      headers,
    });
    expect(repeated.statusCode, repeated.body).toBe(400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
