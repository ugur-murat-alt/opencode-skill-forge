import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packageInventory } from "../src/skills/paths.js";
test("inventory bounds empty directories and rejects redirected ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-inventory-"));
  try {
    const many = join(root, "many");
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 1281 }, (_, index) =>
        mkdir(join(many, `empty-${index}`)),
      ),
    );
    await expect(packageInventory(many)).rejects.toMatchObject({
      code: "package_limit",
    });
    const actual = join(root, "actual");
    await mkdir(join(actual, "package"), { recursive: true });
    await writeFile(join(actual, "package", "file.txt"), "file");
    await symlink(actual, join(root, "redirect"));
    await expect(
      packageInventory(join(root, "redirect", "package")),
    ).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await packageInventory(join(actual, "package"))).toEqual([
      "file.txt",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
