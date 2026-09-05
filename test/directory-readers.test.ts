import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DirectoryReaders } from "../src/skills/directory-readers.js";
import type { PackageDirectoryReader } from "../src/skills/paths.js";

test.skipIf(process.platform !== "linux")(
  "overlapping roots share only live descriptor, isolate callback errors and reopen after release",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-directory-readers-"));
    const parent = join(root, "parent"),
      packageRoot = join(parent, "package"),
      outside = join(root, "outside");
    const pool = new DirectoryReaders();
    let saved: PackageDirectoryReader | undefined;
    try {
      await mkdir(packageRoot, { recursive: true });
      await mkdir(join(outside, "package"), { recursive: true });
      await writeFile(join(packageRoot, "SKILL.md"), "original");
      await writeFile(join(outside, "package", "SKILL.md"), "outside");
      await pool.withDirectory(packageRoot, async (first) => {
        saved = first;
        await rename(parent, parent + "-held");
        await symlink(outside, parent);
        await expect(
          pool.withDirectory(packageRoot, async (second) => {
            expect(second).toBe(first);
            expect((await second.read("SKILL.md")).toString()).toBe("original");
            throw new Error("one reader failed");
          }),
        ).rejects.toThrow("one reader failed");
        await writeFile(
          join(parent + "-held", "package", "SKILL.md"),
          "changed real bytes",
        );
        expect((await first.read("SKILL.md")).toString()).toBe(
          "changed real bytes",
        );
        expect(await first.inventory()).toEqual(["SKILL.md"]);
      });
      await expect(saved!.read("SKILL.md")).rejects.toMatchObject({
        code: "reader_closed",
      });
      await expect(
        pool.withDirectory(packageRoot, (r) => r.inventory()),
      ).rejects.toMatchObject({ code: "unsafe_path" });
      await rm(parent);
      await rename(parent + "-held", parent);
      await pool.withDirectory(packageRoot, async (next) => {
        expect(next).not.toBe(saved);
        expect((await next.read("SKILL.md")).toString()).toBe(
          "changed real bytes",
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
