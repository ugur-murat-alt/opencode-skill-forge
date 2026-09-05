import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { MigrationImporter } from "../src/migration/importer.js";
const hash = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`migration ${backend}: atomic receipt, replay, source guard and conservative rollback`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-import-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    try {
      const identities = new IdentityService(storage.db),
        owner = await identities.bootstrapLocal(),
        project = await identities.createProject(owner, "Migration contract"),
        store = new PackageStore(storage, root),
        importer = new MigrationImporter(store);
      const name = `import-${randomUUID()}`,
        source = join(root, "legacy"),
        content = Buffer.from(
          `---\nname: ${name}\ndescription: Preserve an original migration package.\n---\nUse the documented method.\n`,
        );
      await mkdir(join(source, name), { recursive: true });
      await writeFile(join(source, name, "SKILL.md"), content);
      const input = {
        source_root: source,
        path: name,
        checksum: hash(
          JSON.stringify([
            { path: "SKILL.md", bytes: content.length, sha256: hash(content) },
          ]),
        ),
        scope: "project",
        project_ref: project.id,
        flags: { managed: false, protected: true, pinned: true },
      };
      await expect(
        importer.importPackage(owner, { ...input, checksum: "0".repeat(64) }),
      ).rejects.toMatchObject({ code: "source_changed" });
      const first = await importer.importPackage(owner, input);
      const replay = await importer.importPackage(owner, input);
      expect(replay.replayed).toBe(true);
      expect(replay.skill_id).toBe(first.skill_id);
      const row = await storage.db
        .selectFrom("skills")
        .selectAll()
        .where("tenant_id", "=", owner.tenantId)
        .where("id", "=", first.skill_id)
        .executeTakeFirstOrThrow();
      expect([row.managed, row.protected, row.pinned]).toEqual([0, 1, 1]);
      // Explicit receipt rollback undoes only the untouched imported state, including its imported flags.
      expect((await importer.rollback(owner, first.receipt_id)).replayed).toBe(
        false,
      );
      expect((await importer.rollback(owner, first.receipt_id)).replayed).toBe(
        true,
      );
      expect((await importer.importPackage(owner, input)).state).toBe(
        "rolled_back",
      );
      expect(await readFile(join(source, name, "SKILL.md"))).toEqual(content);
      expect(
        (await store.files(owner, first.skill_id, first.revision)).files[
          "SKILL.md"
        ],
      ).toEqual(content);
      const nextName = `import-${randomUUID()}`,
        nextContent = content.toString().replace(name, nextName);
      await mkdir(join(source, nextName));
      await writeFile(join(source, nextName, "SKILL.md"), nextContent);
      const nextInput = {
        ...input,
        path: nextName,
        checksum: hash(
          JSON.stringify([
            {
              path: "SKILL.md",
              bytes: Buffer.byteLength(nextContent),
              sha256: hash(nextContent),
            },
          ]),
        ),
        flags: { managed: true, protected: false, pinned: false },
      };
      const next = await importer.importPackage(owner, nextInput);
      await storage.db
        .updateTable("skills")
        .set({ updated_at: Date.now() + 10000 })
        .where("tenant_id", "=", owner.tenantId)
        .where("id", "=", next.skill_id)
        .execute();
      await expect(
        importer.rollback(owner, next.receipt_id),
      ).rejects.toMatchObject({ code: "migration_target_changed" });
      await expect(
        importer.importPackage(owner, {
          ...nextInput,
          flags: { ...nextInput.flags, pinned: true },
        }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      const receipts = await storage.db
        .selectFrom("migration_receipts")
        .selectAll()
        .where("tenant_id", "=", owner.tenantId)
        .where("project_id", "=", project.id)
        .execute();
      expect(receipts).toHaveLength(2);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
