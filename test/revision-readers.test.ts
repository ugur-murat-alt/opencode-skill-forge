import { MemberService } from "../src/application/members.js";
import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { secureRead } from "../src/skills/paths.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`revision readers ${backend}: independent live references, FK, real bytes and corrupt cleanup`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-readers-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    let releaseFirst = () => {},
      releaseSecond = () => {};
    let first: Promise<Buffer> | undefined, second: Promise<Buffer> | undefined;
    try {
      const identity = new IdentityService(storage.db),
        admin = await identity.bootstrapLocal(),
        project = await identity.createProject(admin, "Reader references");
      const member = await new MemberService(storage.db).create(admin, {
        subject: `fixture|${crypto.randomUUID()}`,
        display_name: "Reader editor",
        role: "editor",
      });
      const owner = { ...admin, userId: member.user_id };
      const grant = {
        tenant_id: owner.tenantId,
        user_id: owner.userId,
        project_id: project.id,
        role: "editor" as const,
      };
      await storage.db.insertInto("project_members").values(grant).execute();
      let reading = 0;
      const store = new PackageStore(storage, root),
        name = `reader-${crypto.randomUUID()}`;
      const bytes = Buffer.from(
        `---\nname: ${name}\ndescription: Eşzamanlı gerçek dosya okuma koruması.\n---\n# Yöntem\nReferans okuma bitene kadar kalır.\n`,
      );
      const pkg = await store.publish(owner, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: { "SKILL.md": bytes },
      });
      const gate1 = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
        gate2 = new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
      const count = () =>
        storage.db
          .selectFrom("revision_readers")
          .selectAll()
          .where("tenant_id", "=", owner.tenantId)
          .where("skill_id", "=", pkg.skill_id)
          .execute();
      first = store.withRevision(
        owner,
        pkg.skill_id,
        pkg.revision,
        async (_skill, row) => {
          reading++;
          await gate1;
          return secureRead(join(root, row.package_path), "SKILL.md");
        },
      );
      second = store.withRevision(
        owner,
        pkg.skill_id,
        pkg.revision,
        async (_skill, row) => {
          reading++;
          await gate2;
          return secureRead(join(root, row.package_path), "SKILL.md");
        },
      );
      const deadline = Date.now() + 3000;
      while (reading < 2 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reading).toBe(2);
      expect(await count()).toHaveLength(1);
      await storage.db
        .deleteFrom("project_members")
        .where("tenant_id", "=", owner.tenantId)
        .where("user_id", "=", owner.userId)
        .where("project_id", "=", project.id)
        .execute();
      await expect(
        store.files(owner, pkg.skill_id, pkg.revision),
      ).rejects.toMatchObject({ status: 403 });
      expect(await count()).toHaveLength(1);
      await storage.db.insertInto("project_members").values(grant).execute();
      await expect(
        storage.db.transaction().execute(async (tx) => {
          await tx
            .updateTable("skills")
            .set({ active_revision: null })
            .where("tenant_id", "=", owner.tenantId)
            .where("id", "=", pkg.skill_id)
            .execute();
          await tx
            .deleteFrom("skill_revisions")
            .where("tenant_id", "=", owner.tenantId)
            .where("skill_id", "=", pkg.skill_id)
            .execute();
        }),
      ).rejects.toThrow();
      releaseFirst();
      expect(await first).toEqual(bytes);
      expect(await count()).toHaveLength(1);
      releaseSecond();
      expect(await second).toEqual(bytes);
      expect(await count()).toHaveLength(0);
      const loaded = await store.files(owner, pkg.skill_id, pkg.revision);
      expect(loaded.files["SKILL.md"]).toEqual(bytes);
      expect(await count()).toHaveLength(0);
      await writeFile(join(loaded.path, "SKILL.md"), "broken");
      await expect(
        store.files(owner, pkg.skill_id, pkg.revision),
      ).rejects.toMatchObject({ code: "revision_corrupt" });
      expect(await count()).toHaveLength(0);
      const report = await store.reconcile(admin, {
        skill_id: pkg.skill_id,
        revision: "",
      });
      expect(report.issues.some((i) => i.skill_id === pkg.skill_id)).toBe(true);
      expect(await count()).toHaveLength(0);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled([first, second]);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}
