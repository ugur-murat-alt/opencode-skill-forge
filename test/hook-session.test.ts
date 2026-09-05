import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientHook } from "../src/clients/hook.js";
import { PRODUCT_VERSION, PROTOCOL_VERSION } from "../src/cli/config.js";
test("Codex and Claude hook HTTP payload carries its source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-hook-session-")),
    received: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") {
      res.end(
        JSON.stringify({
          service: "skill-forge",
          version: PRODUCT_VERSION,
          protocol: PROTOCOL_VERSION,
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/api/tools/forge_prepare") {
      const value = JSON.parse(body);
      received.push(value);
      res.end(
        JSON.stringify({
          status: "unchanged",
          effective: value.original,
          auto_applied: false,
        }),
      );
    } else {
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    for (const client of ["codex", "claude"] as const)
      await clientHook(
        {
          dataDir: root,
          host: "127.0.0.1",
          port: address.port,
          url: `http://127.0.0.1:${address.port}`,
          token: "fixture-owner",
        },
        "unused-entry",
        ("" + client) as typeof client,
        "project-fixture",
        {
          hook_event_name: "UserPromptSubmit",
          session_id: `${client}-session`,
          prompt: "Preserve explicit constraints.",
          cwd: root,
        },
      );
    expect(received.map((x) => x.source)).toEqual([
      { client: "codex", session: "codex-session" },
      { client: "claude", session: "claude-session" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
