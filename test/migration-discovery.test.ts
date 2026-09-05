import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLegacy } from "../src/migration/discover.js";
test("legacy discovery preserves bytes, reports malformed and duplicate data, and keeps home learning private", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-migration-discovery-")),
    project = join(root, "project"),
    home = join(root, "home");
  const skill =
    "---\nname: portable-method\ndescription: Preserve a verified portable method.\n---\n[Reference](references/info.md)\n";
  try {
    for (const base of [
      join(project, ".opencode/skills"),
      join(home, ".config/opencode/skills"),
    ]) {
      await mkdir(join(base, "portable-method/references"), {
        recursive: true,
      });
      await writeFile(join(base, "portable-method/SKILL.md"), skill);
      await writeFile(
        join(base, "portable-method/references/info.md"),
        "Original reference.",
      );
    }
    const state = join(home, ".opencode/.skill-power/prompt-editor");
    await mkdir(state, { recursive: true });
    const rewrites =
      JSON.stringify({
        ts: 1,
        sessionID: "private-session",
        messageID: "message",
        original: "PRIVATE ORIGINAL",
        rewritten: "PRIVATE RESULT",
      }) + "\n{broken\n";
    await writeFile(join(state, "rewrites.jsonl"), rewrites);
    await writeFile(
      join(state, "learn.md"),
      "# Prompt Editor — Learn\n\n## [1234567890123]\nPRIVATE LESSON\n",
    );
    await writeFile(join(state, "session-flags.json"), "{}");
    await symlink(
      join(root, "outside"),
      join(project, ".opencode/skills/redirect"),
    );
    const report = await discoverLegacy({ projectRoot: project, home });
    expect(report.truncated).toBe(false);
    const limited = await discoverLegacy({
      projectRoot: project,
      home,
      maxEntries: 1,
    });
    expect(limited.truncated).toBe(true);
    expect(
      limited.roots.some((root) => root.status === "not_scanned_limit"),
    ).toBe(true);
    const packages = report.items.filter(
      (i) => i.kind === "package" && i.status === "ready",
    );
    expect(packages).toHaveLength(2);
    expect(packages.filter((i) => i.duplicate_of)).toHaveLength(1);
    expect(report.items.find((i) => i.path === "redirect")?.status).toBe(
      "unreadable",
    );
    const stateItems = report.items.filter((i) => i.kind === "state");
    expect(stateItems.every((i) => i.target_scope === "personal")).toBe(true);
    expect(
      stateItems.find((i) => i.path.endsWith("rewrites.jsonl"))?.summary,
    ).toEqual({ records: 1, malformed: 1 });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
    expect(await readFile(join(state, "rewrites.jsonl"), "utf8")).toBe(
      rewrites,
    );
    expect(
      (await discoverLegacy({ projectRoot: project, home })).checksum,
    ).toBe(report.checksum);
    expect(await readdir(project)).toEqual([".opencode"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration CLI does not initialize daemon data or write into legacy sources", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stat } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "forge-migration-cli-")),
    project = join(root, "project"),
    home = join(root, "home"),
    data = join(root, "new-service-data");
  try {
    await mkdir(join(project, ".opencode/skills"), { recursive: true });
    await mkdir(home);
    const env = {
      PATH: process.env.PATH,
      SKILL_FORGE_DATA_DIR: data,
      OC_SKILL_POWER_HOME: join(root, "legacy-home"),
    };
    const args = [
      "dist/cli.js",
      "migration-scan",
      "--project",
      project,
      "--legacy-home",
      home,
    ];
    const result = await promisify(execFile)("node", args, { env });
    expect(JSON.parse(result.stdout).mode).toBe("read_only");
    await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      promisify(execFile)(
        "node",
        [...args, "--output", join(project, ".opencode/skills/manifest.json")],
        { env },
      ),
    ).rejects.toThrow();
    expect(await readdir(join(project, ".opencode/skills"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
