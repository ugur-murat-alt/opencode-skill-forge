import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const exec = promisify(execFile);

test("catalog setup rejects bad arguments and cleans a failed runtime copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-benchmark-setup-"));
  const temp = join(root, "temp"),
    cwd = join(root, "empty");
  await mkdir(temp);
  await mkdir(cwd);
  try {
    const options = {
      cwd,
      env: {
        PATH: process.env.PATH,
        TMPDIR: temp,
        OC_SKILL_POWER_HOME: join(root, "legacy"),
        SKILL_FORGE_DATA_DIR: join(root, "data"),
      },
      timeout: 5000,
    };
    for (const { args, message } of [
      { args: ["9"], message: "Catalog size" },
      { args: ["10"], message: "ENOENT" },
      {
        args: ["10", "invalid.txt", "--cpu-profile"],
        message: "explicit .json",
      },
    ]) {
      let failed = false;
      try {
        await exec(
          process.execPath,
          [resolve("scripts/catalog-benchmark.ts"), ...args],
          options,
        );
      } catch (error) {
        failed = true;
        expect(String((error as { stderr: string }).stderr)).toContain(
          message!,
        );
      }
      expect(failed).toBe(true);
      expect(
        (await readdir(temp)).filter((name) =>
          name.startsWith("forge-catalog-benchmark-"),
        ),
      ).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
