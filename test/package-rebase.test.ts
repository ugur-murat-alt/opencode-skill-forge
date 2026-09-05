import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageManager } from "../src/application/packages.js";
import { PackageStore } from "../src/skills/store.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`bounded package rebase ${backend}: preserves independent edits, rejects conflicts and revalidates`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-rebase-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    try {
      const identities = new IdentityService(storage.db),
        owner = await identities.bootstrapLocal(),
        project = await identities.createProject(owner, "Rebase contract");
      const store = new PackageStore(storage, root),
        manager = new PackageManager(store),
        name = `rebase-${crypto.randomUUID()}`;
      const files = {
        "SKILL.md": Buffer.from(
          `---\nname: ${name}\ndescription: Preserve independent package changes.\n---\n[Details](references/details.md)\n[Keep](references/keep.md)\n`,
        ),
        "references/details.md": Buffer.from("base"),
        "references/keep.md": Buffer.from("base"),
      };
      const first = await store.publish(owner, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files,
      });
      const liveFiles = {
        ...files,
        "SKILL.md": Buffer.concat([
          files["SKILL.md"],
          Buffer.from("Concurrent instruction.\n"),
        ]),
      };
      const live = await store.publish(owner, {
        name,
        skillId: first.skill_id,
        scope: "project",
        projectId: project.id,
        baseRevision: first.revision,
        files: liveFiles,
      });
      const edit = {
        base_revision: first.revision,
        changes: [
          {
            path: "references/details.md",
            original_hash: createHash("sha256").update("base").digest("hex"),
            content: "new details",
          },
        ],
      };
      await expect(
        manager.edit(owner, first.skill_id, edit),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      const merged = await manager.edit(owner, first.skill_id, {
        ...edit,
        rebase: true,
      });
      const loaded = await store.files(owner, first.skill_id, merged.revision);
      expect(loaded.files["SKILL.md"]!.equals(liveFiles["SKILL.md"])).toBe(
        true,
      );
      expect(loaded.files["references/details.md"]!.toString()).toBe(
        "new details",
      );
      expect(
        (await store.files(owner, first.skill_id, first.revision)).files[
          "references/details.md"
        ]!.toString(),
      ).toBe("base");
      await expect(
        manager.edit(owner, first.skill_id, {
          ...edit,
          rebase: true,
          changes: [{ ...edit.changes[0], content: "conflicting details" }],
        }),
      ).rejects.toMatchObject({ code: "rebase_conflict" });
      // A conflict-free file deletion still must pass complete-package validation.
      await expect(
        manager.edit(owner, first.skill_id, {
          base_revision: live.revision,
          rebase: true,
          changes: [
            {
              path: "references/keep.md",
              original_hash: createHash("sha256").update("base").digest("hex"),
              content: null,
            },
          ],
        }),
      ).rejects.toThrow();
      expect(
        (await store.authorizedSkill(owner, first.skill_id)).active_revision,
      ).toBe(merged.revision);
      const replay = await manager.edit(owner, first.skill_id, {
        ...edit,
        rebase: true,
      });
      expect(replay.decision).toBe("no-op");
      await store.storage.db
        .updateTable("skills")
        .set({ pinned: 1 })
        .where("tenant_id", "=", owner.tenantId)
        .where("id", "=", first.skill_id)
        .execute();
      await expect(
        manager.edit(owner, first.skill_id, { ...edit, rebase: true }),
      ).rejects.toMatchObject({ code: "skill_protected" });
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
}
