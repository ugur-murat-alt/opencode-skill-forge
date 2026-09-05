import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLegacy } from "../src/migration/discover.js";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
const exec = promisify(execFile);
test("Node migration CLI: explicit personal mapping, per-item failure, replay and reversible receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-migration-cli-")),
    home = join(root, "home"),
    project = join(root, "project"),
    data = join(root, "data");
  try {
    await mkdir(data, { mode: 0o700 });
    const storage = await openDatabase({ dataDir: data });
    const identities = new IdentityService(storage.db),
      owner = await identities.bootstrapLocal(),
      destination = await identities.createProject(owner, "CLI migration");
    await storage.close();
    const source = join(home, ".config/opencode/skills/portable-method"),
      content =
        "---\nname: portable-method\ndescription: Apply a portable verified method.\n---\n[Details](references/detail.md)\n";
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), content);
    await writeFile(
      join(source, "references/detail.md"),
      "Original binary-safe reference",
    );
    const report = await discoverLegacy({ projectRoot: project, home });
    const manifest = join(root, "manifest.json"),
      mapping = join(root, "mapping.json");
    await writeFile(manifest, JSON.stringify(report));
    const selected = report.items.find((x) => x.kind === "package")!;
    const map = {
      version: 1,
      owner: "local-owner",
      project_ref: destination.id,
      manifest_checksum: report.checksum,
      items: [
        {
          source_id: selected.source_id,
          flags: { managed: true, protected: false, pinned: false },
        },
        {
          source_id: "0".repeat(64),
          flags: { managed: false, protected: false, pinned: false },
        },
      ],
    };
    await writeFile(mapping, JSON.stringify(map));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      SKILL_FORGE_PROFILE: "local",
      SKILL_FORGE_DATA_DIR: data,
      OC_SKILL_POWER_HOME: join(root, "old-state"),
    };
    const args = [
      "dist/cli.js",
      "migration-import",
      "--manifest",
      manifest,
      "--mapping",
      mapping,
      "--data-dir",
      data,
    ];
    const partial = await exec("node", args, { env }).then(
      () => {
        throw Error("Expected partial exit 1");
      },
      (error) => {
        expect(error.code).toBe(1);
        return JSON.parse(error.stdout);
      },
    );
    expect(partial.failed).toBe(1);
    expect(partial.results[0].state).toBe("applied");
    expect(partial.results[1].error.code).toBe("package_not_importable");
    map.items.pop();
    await writeFile(mapping, JSON.stringify(map));
    const replay = JSON.parse((await exec("node", args, { env })).stdout);
    expect(replay.failed).toBe(0);
    expect(replay.results[0].replayed).toBe(true);
    const check = await openDatabase({ dataDir: data });
    try {
      const skill = await check.db
        .selectFrom("skills")
        .selectAll()
        .where("id", "=", replay.results[0].skill_id)
        .executeTakeFirstOrThrow();
      expect(skill.scope_key).toBe(`personal:${owner.userId}`);
      expect(skill.owner_id).toBe(owner.userId);
    } finally {
      await check.close();
    }
    const rollback = JSON.parse(
      (
        await exec(
          "node",
          [
            "dist/cli.js",
            "migration-rollback",
            "--data-dir",
            data,
            "--receipt",
            replay.results[0].receipt_id,
          ],
          { env },
        )
      ).stdout,
    );
    expect(rollback.state).toBe("rolled_back");
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(content);
    map.manifest_checksum = "0".repeat(64);
    await writeFile(mapping, JSON.stringify(map));
    const rejected = await exec("node", args, { env }).catch((error) => error);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("mapping_changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node learning migration CLI preserves the source and exports exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-learning-cli-")),
    home = join(root, "home"),
    project = join(root, "project"),
    data = join(root, "data");
  try {
    await mkdir(data, { mode: 0o700 });
    const storage = await openDatabase({ dataDir: data });
    const ids = new IdentityService(storage.db),
      owner = await ids.bootstrapLocal(),
      destination = await ids.createProject(owner, "CLI learning");
    await storage.close();
    const source = join(home, ".opencode/.skill-power/prompt-editor");
    await mkdir(source, { recursive: true });
    const content = Buffer.from(
      "# Prompt Editor — Learn\r\n\r\n## [1700000000000]\r\n" +
        "Preserve explicit quantities and versions. ".repeat(60).trim() +
        "\r\n",
    );
    await writeFile(join(source, "learn.md"), content);
    const report = await discoverLegacy({ projectRoot: project, home }),
      item = report.items.find((x) => x.path.endsWith("learn.md"))!;
    const manifest = join(root, "manifest.json"),
      mapping = join(root, "mapping.json");
    await writeFile(manifest, JSON.stringify(report));
    await writeFile(
      mapping,
      JSON.stringify({
        version: 1,
        owner: "local-owner",
        project_ref: destination.id,
        manifest_checksum: report.checksum,
        items: [{ source_id: item.source_id, learning: { enabled: false } }],
      }),
    );
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      SKILL_FORGE_PROFILE: "local",
      SKILL_FORGE_DATA_DIR: data,
      OC_SKILL_POWER_HOME: join(root, "old-state"),
    };
    const output = JSON.parse(
      (
        await exec(
          "node",
          [
            "dist/cli.js",
            "migration-import",
            "--manifest",
            manifest,
            "--mapping",
            mapping,
          ],
          { env },
        )
      ).stdout,
    );
    expect(output.failed).toBe(0);
    expect(output.results[0].records[0].status).toBe("created");
    const receipt = output.results[0].receipt_id;
    const exported = await exec(
      "node",
      ["dist/cli.js", "migration-learning-export", "--receipt", receipt],
      { env, encoding: "buffer" },
    );
    expect(exported.stdout).toEqual(content);
    const rolled = JSON.parse(
      (
        await exec(
          "node",
          ["dist/cli.js", "migration-learning-rollback", "--receipt", receipt],
          { env },
        )
      ).stdout,
    );
    expect(rolled.state).toBe("rolled_back");
    expect(await readFile(join(source, "learn.md"))).toEqual(content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node flag migration CLI maps one legacy session and preserves original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-flags-cli-")),
    home = join(root, "home"),
    project = join(root, "project"),
    data = join(root, "data");
  try {
    await mkdir(data, { mode: 0o700 });
    const storage = await openDatabase({ dataDir: data }),
      ids = new IdentityService(storage.db),
      owner = await ids.bootstrapLocal(),
      destination = await ids.createProject(owner, "CLI session flags");
    await storage.close();
    const source = join(home, ".opencode/.skill-power/prompt-editor");
    await mkdir(source, { recursive: true });
    const bytes = Buffer.from(
      '{"old-session":{"enabled":false,"autoAccept":false}}\r\n',
    );
    await writeFile(join(source, "session-flags.json"), bytes);
    const report = await discoverLegacy({ projectRoot: project, home }),
      item = report.items.find((x) => x.path.endsWith("session-flags.json"))!,
      manifest = join(root, "manifest.json"),
      mapping = join(root, "mapping.json");
    await writeFile(manifest, JSON.stringify(report));
    await writeFile(
      mapping,
      JSON.stringify({
        version: 1,
        owner: "local-owner",
        project_ref: destination.id,
        manifest_checksum: report.checksum,
        items: [
          {
            source_id: item.source_id,
            sessions: [
              {
                legacy_session: "old-session",
                target: { client: "codex", session: "new-session" },
                base_revision: 0,
                defaults: { enabled: true, autoAccept: true },
              },
            ],
          },
        ],
      }),
    );
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      SKILL_FORGE_PROFILE: "local",
      SKILL_FORGE_DATA_DIR: data,
      OC_SKILL_POWER_HOME: join(root, "old-state"),
    };
    const result = JSON.parse(
      (
        await exec(
          "node",
          [
            "dist/cli.js",
            "migration-import",
            "--manifest",
            manifest,
            "--mapping",
            mapping,
          ],
          { env },
        )
      ).stdout,
    );
    expect(result.failed).toBe(0);
    expect(result.results[0].records[0].status).toBe("applied");
    const receipt = result.results[0].receipt_id;
    const exported = await exec(
      "node",
      ["dist/cli.js", "migration-flags-export", "--receipt", receipt],
      { env, encoding: "buffer" },
    );
    expect(exported.stdout).toEqual(bytes);
    const check = await openDatabase({ dataDir: data });
    try {
      const rows = await check.db
        .selectFrom("session_preferences")
        .selectAll()
        .where("user_id", "=", owner.userId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toEqual({
        promptEnabled: false,
        autoApply: false,
      });
    } finally {
      await check.close();
    }
    expect(
      JSON.parse(
        (
          await exec(
            "node",
            ["dist/cli.js", "migration-flags-rollback", "--receipt", receipt],
            { env },
          )
        ).stdout,
      ).state,
    ).toBe("rolled_back");
    expect(await readFile(join(source, "session-flags.json"))).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
