import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClient, uninstallClient, hookCommand } from "../src/clients/installer.js";
for (const client of ["codex", "claude"] as const) test(`${client} parser merge preserves existing comments/settings, idempotent reinstall and reversible uninstall`, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-install-")), project = join(root, "project"), dataDir = join(root, "private"); await mkdir(join(project, client === "codex" ? ".codex" : ".claude"), { recursive: true });
  const configPath = client === "codex" ? join(project, ".codex/config.toml") : join(project, ".mcp.json");
  const before = client === "codex" ? '# Keep this comment\nmodel = "existing-model"\n[mcp_servers.other]\ncommand = "existing-tool"\n' : '// Keep this comment\n{"mcpServers":{"other":{"command":"existing-tool"}}}\n';
  const instructions = join(project, client === "codex" ? "AGENTS.md" : "CLAUDE.md");
  await writeFile(configPath, before); await writeFile(instructions, "# User rules\nKeep my instructions.\n");
  try {
    const input = { client, projectRoot: project, projectRef: "project-id", dataDir, entry: "/opt/forge/cli.js", port: 23456 };
    const first = await installClient(input); expect(first.status).toBe("installed"); expect(await readFile(configPath, "utf8")).toContain("Keep this comment");
    expect((await installClient(input)).status).toBe("unchanged");
    expect((await uninstallClient(client, project, dataDir)).status).toBe("uninstalled"); expect(await readFile(configPath, "utf8")).toBe(before); expect(await readFile(instructions, "utf8")).toBe("# User rules\nKeep my instructions.\n");
    expect((await uninstallClient(client, project, dataDir)).status).toBe("unchanged");
    await installClient(input); await writeFile(configPath, (await readFile(configPath, "utf8")) + (client === "codex" ? "\n# New user edit\n" : "\n// New user edit\n"));
    expect((await uninstallClient(client, project, dataDir)).status).toBe("uninstalled"); expect(await readFile(configPath, "utf8")).toContain("New user edit");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("hook commands quote literal shell metacharacters and Windows uses encoded argv", () => {
  expect(hookCommand("/a/$(touch bad)/cli.js", ["hook", "x'y"], "linux")).toContain("'/a/$(touch bad)/cli.js'");
  const windows = hookCommand("C:\\Path%literal%\\cli.js", ["hook"], "win32"); expect(windows).toMatch(/^powershell.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
});
