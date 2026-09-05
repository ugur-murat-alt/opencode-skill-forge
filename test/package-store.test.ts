import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { validatePackage } from "../src/skills/validate.js";
import { validateInventory, secureRead, readPackageDirectory } from "../src/skills/paths.js";
const files = (name: string, body = "Doğrulanmış yöntem.") => ({ "SKILL.md": Buffer.from(`---\nname: ${name}\ndescription: Türkçe ve JavaScript işlerinde doğrulanmış yöntem.\n---\n# Yöntem\n${body}\n[Referans](references/details.md)\n`), "references/details.md": Buffer.from("Somut girdi ve çıktı.") });
for (const backend of ["sqlite", ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : [])]) {
  test(`package store ${backend}: complete publication, CAS, pinned revisions and scope`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-package-"));
    const storage = await openDatabase({ dataDir: root, ...(backend === "postgres" ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL } : {}) });
    const identity = new IdentityService(storage.db), owner = await identity.bootstrapLocal(), project = await identity.createProject(owner, "Package contract");
    const store = new PackageStore(storage, root), name = `method-${crypto.randomUUID()}`;
    try {
      const first = await store.publish(owner, { name, scope: "project", projectId: project.id, baseRevision: null, files: files(name) });
      expect(first.decision).toBe("create");
      const found = await store.search(owner, { projectId: project.id, query: "TÜRKÇE" }); expect(found.items.some(item => item.skill_id === first.skill_id)).toBe(true);
      const competing = await Promise.allSettled(["Birinci", "İkinci"].map(body => store.publish(owner, { name, scope: "project", projectId: project.id, skillId: first.skill_id, baseRevision: first.revision, files: files(name, body) })));
      expect(competing.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const old = await store.files(owner, first.skill_id, first.revision); expect(old.files["SKILL.md"]!.toString()).toContain("Doğrulanmış yöntem.");
      const current = await store.authorizedSkill(owner, first.skill_id); expect(current.active_revision).not.toBe(first.revision);
      await expect(storage.db.updateTable("skills").set({ active_revision: "missing" }).where("tenant_id", "=", owner.tenantId).where("id", "=", first.skill_id).execute()).rejects.toThrow();
      await storage.db.updateTable("skills").set({ pinned: 1 }).where("tenant_id", "=", owner.tenantId).where("id", "=", first.skill_id).execute();
      await expect(store.publish(owner, { name, scope: "project", projectId: project.id, skillId: first.skill_id, baseRevision: current.active_revision, files: files(name, "Denied") })).rejects.toMatchObject({ code: "skill_protected" });
      const badIdentity = { userId: owner.userId, tenantId: "other" }; await expect(store.files(badIdentity, first.skill_id, first.revision)).rejects.toMatchObject({ code: "skill_unavailable" });
      await expect(store.search(owner, { projectId: "unknown", query: "" })).rejects.toMatchObject({ code: "project_unavailable" });
      await writeFile(join(old.path, "references/details.md"), "altered");
      await expect(store.files(owner, first.skill_id, first.revision)).rejects.toMatchObject({ code: "revision_corrupt" });
    } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
  }, 15000);
}
test("package paths reject traversal, Windows aliases, symlinks, hardlinks and Unicode collisions", async () => {
  for (const path of ["../outside", "C:/outside", "/outside", "a\\b", "a//b", "CON.txt", "dir/file.", "a/../b", "a/./b", "a\0b"]) expect(() => validateInventory([path])).toThrow();
  expect(() => validateInventory(["A.md", "a.md"])).toThrow();
  expect(() => validateInventory(["a", "a/b"])).toThrow();
  const root = await mkdtemp(join(tmpdir(), "forge-path-"));
  try {
    await mkdir(join(root, "package")); await writeFile(join(root, "outside"), "secret");
    await symlink(join(root, "outside"), join(root, "package", "linked"));
    await link(join(root, "outside"), join(root, "package", "hardlinked"));
    await expect(secureRead(join(root, "package"), "linked")).rejects.toThrow();
    await expect(secureRead(join(root, "package"), "hardlinked")).rejects.toThrow();
    await expect(readPackageDirectory(join(root, "package"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("missing references and script packages without executable contracts are rejected", () => {
  expect(() => validatePackage("test", { "SKILL.md": files("test")["SKILL.md"] })).toThrow();
  expect(() => validatePackage("test", { ...files("test"), "scripts/unsafe.js": Buffer.from("console.log('not run')") })).toThrow();
  expect(validatePackage("test", files("test")).files).toHaveLength(2);
});
