import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  symlink,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  withPackageDirectory,
  secureRead,
  type PackageDirectoryReader,
} from "../src/skills/paths.js";
import { ForgeError } from "../src/domain/errors.js";

test.skipIf(process.platform !== "linux")(
  "package root stays on its original inode across ancestor replacement and drains escaped reads",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-root-anchor-"));
    const parent = join(root, "parent"),
      packageRoot = join(parent, "package"),
      outside = join(root, "outside");
    let escaped: Promise<Buffer> | undefined,
      saved: PackageDirectoryReader | undefined;
    try {
      await mkdir(packageRoot, { recursive: true });
      await mkdir(join(outside, "package"), { recursive: true });
      await writeFile(join(packageRoot, "SKILL.md"), "authorized original");
      await writeFile(join(outside, "package", "SKILL.md"), "outside sentinel");
      let completed = false;
      expect(
        await withPackageDirectory(packageRoot, async (reader) => {
          saved = reader;
          await rename(parent, parent + "-held");
          await symlink(outside, parent);
          expect(await reader.inventory()).toEqual(["SKILL.md"]);
          expect((await reader.read("SKILL.md")).toString()).toBe(
            "authorized original",
          );
          escaped = reader.read("SKILL.md").then((bytes) => {
            completed = true;
            return bytes;
          });
          return 42;
        }),
      ).toBe(42);
      expect(completed).toBe(true);
      expect((await escaped!).toString()).toBe("authorized original");
      await expect(saved!.read("SKILL.md")).rejects.toMatchObject({
        code: "reader_closed",
      });
      await expect(saved!.inventory()).rejects.toMatchObject({
        code: "reader_closed",
      });
      await expect(secureRead(packageRoot, "SKILL.md")).rejects.toMatchObject({
        code: "unsafe_path",
      });
      expect(await readFile(join(outside, "package", "SKILL.md"), "utf8")).toBe(
        "outside sentinel",
      );
      completed = false;
      await expect(
        withPackageDirectory(
          join(parent + "-held", "package"),
          async (reader) => {
            escaped = reader.read("SKILL.md").then((bytes) => {
              completed = true;
              return bytes;
            });
            throw new ForgeError("fixture_failure", "callback failure");
          },
        ),
      ).rejects.toMatchObject({ code: "fixture_failure" });
      expect(completed).toBe(true);
      expect((await escaped!).toString()).toBe("authorized original");
    } finally {
      await escaped?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);
