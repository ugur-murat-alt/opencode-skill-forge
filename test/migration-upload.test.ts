import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createHttpServer } from "../src/http/server.js";
import { localConfig } from "../src/cli/config.js";
import { discoverLegacy } from "../src/migration/discover.js";
import { remoteMigrationUpload } from "../src/migration/remote.js";
const exec = promisify(execFile);
test("Node migration upload sends four selected sources over actual HTTP without creating client state", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-upload-")),
    serverRoot = join(root, "server"),
    home = join(root, "home"),
    projectRoot = join(root, "project"),
    clientData = join(root, "client-data");
  await mkdir(serverRoot, { mode: 0o700 });
  const cfg = await localConfig(serverRoot),
    app = await createHttpServer(cfg);
  try {
    await app.listen({ host: cfg.host, port: cfg.port });
    const headers = {
      host: new URL(cfg.url).host,
      authorization: `Bearer ${cfg.token}`,
    };
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "Remote upload fixture" },
      })
    ).json();
    const source = join(home, ".opencode/.skill-power/prompt-editor"),
      skills = join(home, ".config/opencode/skills/remote-helper");
    await mkdir(source, { recursive: true });
    await mkdir(skills, { recursive: true });
    await writeFile(
      join(skills, "SKILL.md"),
      "---\nname: remote-helper\ndescription: Preserve remote migration constraints.\n---\nUse the verified method.\n",
    );
    const learn =
      "# Prompt Editor — Learn\n\n## [1700000000000]\nPreserve explicit quantities.\n";
    await writeFile(join(source, "learn.md"), learn);
    await writeFile(
      join(source, "rewrites.jsonl"),
      JSON.stringify({
        ts: 1700000000000,
        sessionID: "old",
        messageID: "one",
        outcome: "rewritten",
        original: "Preserve scope.",
        rewritten: "Preserve explicit scope.",
        durationMs: 12,
      }) + "\n",
    );
    await writeFile(
      join(source, "session-flags.json"),
      JSON.stringify({ old: { enabled: false, autoAccept: false } }),
    );
    const manifest = await discoverLegacy({ projectRoot, home }),
      manifestPath = join(root, "manifest.json"),
      mappingPath = join(root, "mapping.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const mapping = {
      version: 1,
      owner: "authenticated-user",
      project_ref: project.id,
      manifest_checksum: manifest.checksum,
      items: manifest.items.map((item) => ({
        source_id: item.source_id,
        ...(item.kind === "package"
          ? { flags: { managed: true, protected: false, pinned: false } }
          : item.path.endsWith("learn.md")
            ? { learning: { enabled: false } }
            : item.path.endsWith("rewrites.jsonl")
              ? { rewrites: true }
              : {
                  sessions: [
                    {
                      legacy_session: "old",
                      target: { client: "codex", session: "new" },
                      base_revision: 0,
                      defaults: { enabled: true, autoAccept: true },
                    },
                  ],
                }),
      })),
    };
    await writeFile(mappingPath, JSON.stringify(mapping));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      SKILL_FORGE_DATA_DIR: clientData,
      OC_SKILL_POWER_HOME: join(root, "old-data"),
      SKILL_FORGE_REMOTE_TOKEN: cfg.token,
    };
    const args = [
      "dist/cli.js",
      "migration-upload",
      "--server-url",
      cfg.url,
      "--tenant-id",
      "local",
      "--manifest",
      manifestPath,
      "--mapping",
      mappingPath,
    ];
    const output = await exec("node", args, { env });
    expect(output.stdout).not.toContain(cfg.token);
    expect(output.stderr).not.toContain(cfg.token);
    const result = JSON.parse(output.stdout);
    expect(result.selected).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.results.every((x: any) => x.state === "applied")).toBe(true);
    await expect(stat(clientData)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(source, "learn.md"), "utf8")).toBe(learn);
    const replay = JSON.parse((await exec("node", args, { env })).stdout);
    expect(replay.results.every((x: any) => x.replayed)).toBe(true);
    await writeFile(
      join(source, "learn.md"),
      learn + "Changed after discovery.",
    );
    const failed = await exec("node", args, { env }).catch((error) => error);
    expect(failed.code).toBe(1);
    const report = JSON.parse(failed.stdout);
    expect(report.failed).toBe(1);
    expect(
      report.results.find((x: any) => x.status === "failed").error.code,
    ).toBe("source_changed");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
test("remote upload rejects insecure destinations and never forwards credentials through redirects", async () => {
  for (const url of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?token=secret",
  ])
    expect(() => remoteMigrationUpload(url, "tenant", "token")).toThrow();
  let forwarded = 0;
  const destination = createServer((_req, res) => {
    forwarded++;
    res.end("{}");
  });
  await new Promise<void>((r) => destination.listen(0, "127.0.0.1", r));
  const target = destination.address() as { port: number };
  const origin = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.port}/leak` });
    res.end();
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  const address = origin.address() as { port: number };
  try {
    await expect(
      remoteMigrationUpload(
        `http://127.0.0.1:${address.port}`,
        "tenant",
        "fixture-token",
      )({}),
    ).rejects.toMatchObject({ code: "remote_unavailable" });
    expect(forwarded).toBe(0);
  } finally {
    await Promise.all([
      new Promise<void>((r) => origin.close(() => r())),
      new Promise<void>((r) => destination.close(() => r())),
    ]);
  }
});
