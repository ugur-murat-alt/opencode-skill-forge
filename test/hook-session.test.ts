import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientHook } from "../src/clients/hook.js";
import { PRODUCT_VERSION, PROTOCOL_VERSION } from "../src/cli/config.js";
test("Codex and Claude hooks pass project context through and deliver handoffs with source sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-hook-session-")),
    received: { url?: string; body: any }[] = [];
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
    received.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const config = {
    dataDir: root,
    host: "127.0.0.1",
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    token: "fixture-owner",
  };
  try {
    for (const client of ["codex", "claude"] as const) {
      const submit = await clientHook(
        config,
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
      const context = (submit as any).hookSpecificOutput?.additionalContext;
      expect(context).toContain("project-fixture");
      expect(context).toContain("Original prompt remains unchanged");
    }
    expect(received.some((x) => x.url === "/api/tools/forge_prepare")).toBe(
      false,
    );
    for (const client of ["codex", "claude"] as const) {
      await clientHook(
        config,
        "unused-entry",
        ("" + client) as typeof client,
        "project-fixture",
        {
          hook_event_name: "Stop",
          session_id: `${client}-session`,
          last_assistant_message: "Verified reusable method summary.",
          cwd: root,
        },
      );
    }
    const handoffs = received.filter(
      (x) => x.url === "/api/tools/forge_handoff",
    );
    expect(handoffs.map((x) => x.body.source)).toEqual([
      { client: "codex-stop-hook", session: "codex-session" },
      { client: "claude-stop-hook", session: "claude-session" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
