import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
const exec = promisify(execFile),
  root = await mkdtemp(join(tmpdir(), "forge-client-smoke-"));
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const data = join(root, "data"),
  project = join(root, "project"),
  clientHome = join(root, "client-home"),
  cli = resolve("dist/cli.js");
await mkdir(project);
await mkdir(clientHome);
await exec("git", ["init", "--quiet", project]);
const daemon = spawn(
  process.execPath,
  [cli, "serve", "--data-dir", data, "--port", String(port)],
  { stdio: "ignore" },
);
const output = {
  fixture: "owned temporary project and service; no live model",
  clients: [],
};
try {
  let token;
  for (let i = 0; i < 100; i++) {
    try {
      token = await readFile(join(data, "owner-token"), "utf8");
      const response = await fetch(`http://127.0.0.1:${port}/ready`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Actual client config smoke" }),
  });
  if (!response.ok) throw Error("project creation failed");
  const actorProject = await response.json();
  for (const client of ["codex", "claude"]) {
    const args = [
      cli,
      "install",
      "--client",
      client,
      "--project",
      project,
      "--project-ref",
      actorProject.id,
      "--data-dir",
      data,
      "--port",
      String(port),
    ];
    const installed = JSON.parse(
      (await exec(process.execPath, args, { timeout: 20000 })).stdout,
    );
    if (installed.status !== "installed")
      throw Error("installer did not write config");
    const repeat = JSON.parse(
      (await exec(process.execPath, args, { timeout: 20000 })).stdout,
    );
    if (repeat.status !== "unchanged") throw Error("installer not idempotent");
    if (client === "codex") {
      await writeFile(
        join(clientHome, "config.toml"),
        `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
      );
      const env = { ...process.env, CODEX_HOME: clientHome };
      const version = (
        await exec("codex", ["--version"], { env })
      ).stdout.trim();
      const config = JSON.parse(
        (
          await exec("codex", ["mcp", "get", "skill_forge", "--json"], {
            cwd: project,
            env,
          })
        ).stdout,
      );
      if (config.transport?.command !== process.execPath)
        throw Error("Codex did not load generated project MCP config");
      output.clients.push({
        client,
        version,
        config_parsed: true,
        hooks: "require client trust review",
        live_agent: "not_run",
      });
    } else {
      const destination = join(root, "claude-runtime");
      await exec(
        "npm",
        [
          "install",
          "--prefix",
          destination,
          "--no-audit",
          "--no-fund",
          "@anthropic-ai/claude-code@2.1.261",
          "@anthropic-ai/claude-code-linux-x64@2.1.261",
        ],
        {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
        },
      );
      const nativeRoot = join(
        destination,
        "node_modules",
        "@anthropic-ai",
        "claude-code-linux-x64",
      );
      const nativeFiles = await readdir(nativeRoot, { recursive: true });
      const native = nativeFiles.find(
        (path) => path === "claude" || path.endsWith("/claude"),
      );
      if (!native) throw Error("native executable missing");
      const binary = join(nativeRoot, native),
        env = { ...process.env, CLAUDE_CONFIG_DIR: join(clientHome, "claude") };
      const version = (
        await exec(binary, ["--version"], { env, timeout: 10000 })
      ).stdout.trim();
      const config = (
        await exec(binary, ["mcp", "get", "skill_forge"], {
          cwd: project,
          env,
          timeout: 20000,
        })
      ).stdout;
      if (!config.includes("skill_forge") || !config.includes(cli))
        throw Error("Claude did not load generated MCP config");
      output.clients.push({
        client,
        version,
        config_parsed: true,
        status: config.includes("Pending approval")
          ? "client_approval_required"
          : config.includes("Connected")
            ? "connected"
            : "inspectable",
        live_agent: "not_run",
      });
    }
    await exec(
      process.execPath,
      [
        cli,
        "uninstall",
        "--client",
        client,
        "--project",
        project,
        "--data-dir",
        data,
        "--port",
        String(port),
      ],
      { timeout: 10000 },
    );
  }
  output.status = "passed";
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
} finally {
  daemon.kill("SIGTERM");
  await new Promise((r) => {
    daemon.once("exit", r);
    setTimeout(r, 3000);
  });
  if (daemon.exitCode === null) daemon.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
