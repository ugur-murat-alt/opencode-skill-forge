import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { resolveProvider } from "../src/runner/providers.js";
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function config() { const root = await mkdtemp(join(tmpdir(), "forge-service-")); roots.push(root); return localConfig(root); }
describe("independent service", () => {
  test("concurrent initialization converges on one owner credential and endpoint", async () => {
    const first = await config();
    const values = await Promise.all(Array.from({ length: 10 }, () => localConfig(first.dataDir)));
    expect(new Set(values.map(value => value.token)).size).toBe(1);
    expect(new Set(values.map(value => value.url)).size).toBe(1);
    expect((await stat(join(first.dataDir, "owner-token"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(first.dataDir, "owner-token"), "utf8")).toBe(first.token);
  });
  test("health and MCP require owner identity and exact origin/host", async () => {
    const cfg = await config(); const app = await createHttpServer(cfg);
    try {
      const headers = { host: new URL(cfg.url).host, authorization: `Bearer ${cfg.token}` };
      expect((await app.inject({ url: "/health", headers })).statusCode).toBe(200);
      expect((await app.inject({ url: "/health", headers: { host: headers.host } })).statusCode).toBe(401);
      expect((await app.inject({ url: "/health", headers: { ...headers, origin: "http://evil.test" } })).statusCode).toBe(403);
      expect((await app.inject({ url: "/health", headers: { ...headers, host: "evil.test" } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  test("official v2 HTTP client initializes and reconnects", async () => {
    const cfg = await config(); const app = await createHttpServer(cfg); await app.listen({ host: cfg.host, port: cfg.port });
    try {
      for (let i = 0; i < 2; i++) {
        const client = new Client({ name: "contract", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${cfg.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${cfg.token}` } } }));
        expect(client.getServerVersion()?.name).toBe("skill-forge");
        await client.close();
      }
    } finally { await app.close(); }
  });
  test("provider configuration cannot use ambient credentials, paid fallback or arbitrary URLs", async () => {
    const profile = { provider: "openai" as const, model: "gpt-4.1", allowPaid: false, maxOutputTokens: 100 };
    await expect(resolveProvider(profile, async () => "test-secret", { allowedOrigins: ["https://api.openai.com"], local: false })).rejects.toMatchObject({ code: "paid_model_disabled" });
    await expect(resolveProvider({ ...profile, allowPaid: true }, async () => undefined, { allowedOrigins: ["https://api.openai.com"], local: false })).rejects.toMatchObject({ code: "credential_missing" });
    await expect(resolveProvider({ ...profile, allowPaid: true, baseUrl: "http://169.254.169.254" }, async () => "test", { allowedOrigins: [], local: false })).rejects.toMatchObject({ code: "provider_endpoint_denied" });
    const local = await resolveProvider({ provider: "ollama", model: "configured-model", allowPaid: false, maxOutputTokens: 100 }, async () => undefined, { local: true, allowedOrigins: ["http://127.0.0.1:11434"] });
    expect((await local.models.getAuth("ollama"))?.source).toBe("scope-secret");
  });
});
