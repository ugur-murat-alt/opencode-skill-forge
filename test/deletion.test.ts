import { DeletionService } from "../src/application/deletion.js";
import { test, expect } from "bun:test";
import {
  mkdtemp,
  rm,
  access,
  mkdir,
  writeFile,
  readFile,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { MaintenanceService } from "../src/application/maintenance.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test.skipIf(process.platform !== "linux")(
    `permanent deletion ${backend}: references, real removal, partial replay and symlink confinement`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "forge-deletion-"));
      const dataDir = join(root, "data");
      await mkdir(dataDir, { mode: 0o700 });
      const storage = await openDatabase({
        dataDir,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
      let release = () => {};
      let reading: Promise<unknown> | undefined;
      try {
        const actor = {
            tenantId: crypto.randomUUID(),
            userId: crypto.randomUUID(),
          },
          now = Date.now();
        await storage.db
          .insertInto("tenants")
          .values({
            id: actor.tenantId,
            name: "Deletion fixture",
            created_at: now,
          })
          .execute();
        await storage.db
          .insertInto("users")
          .values({
            id: actor.userId,
            subject: `fixture|${actor.userId}`,
            display_name: "Owner",
            created_at: now,
          })
          .execute();
        await storage.db
          .insertInto("memberships")
          .values({
            tenant_id: actor.tenantId,
            user_id: actor.userId,
            role: "owner",
          })
          .execute();
        const auth = new IdentityService(storage.db),
          project = await auth.createProject(actor, "Deletion");
        const store = new PackageStore(storage, dataDir),
          service = new MaintenanceService(storage, dataDir),
          published = [];
        for (let i = 0; i < 3; i++) {
          const name = `delete-${i}-${crypto.randomUUID()}`;
          const pkg = await store.publish(actor, {
            name,
            scope: "project",
            projectId: project.id,
            baseRevision: null,
            files: {
              "SKILL.md": Buffer.from(
                `---\nname: ${name}\ndescription: Gerçek kalıcı silme doğrulaması.\n---\n# Yöntem\nYalnız seçilen paketi sil.\n`,
              ),
            },
          });
          const loaded = await store.files(actor, pkg.skill_id, pkg.revision),
            row = loaded.skill;
          await service.apply(actor, {
            project_ref: project.id,
            operation_id: crypto.randomUUID(),
            action: "archive",
            items: [
              {
                skill_id: row.id,
                revision: row.active_revision,
                updated_at: row.updated_at,
              },
            ],
          });
          const archived = await store.authorizedSkill(actor, row.id);
          published.push({
            item: {
              skill_id: row.id,
              revision: pkg.revision,
              updated_at: archived.updated_at,
            },
            path: loaded.path,
          });
        }
        const first = published[0]!,
          protectedPkg = published[1]!,
          pendingPkg = published[2]!;
        await storage.db
          .updateTable("skills")
          .set({ protected: 1 })
          .where("tenant_id", "=", actor.tenantId)
          .where("id", "=", protectedPkg.item.skill_id)
          .execute();
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          gate = new Promise<void>((resolve) => {
            release = resolve;
          });
        reading = store.withRevision(
          actor,
          first.item.skill_id,
          first.item.revision,
          async () => {
            entered();
            await gate;
          },
        );
        await started;
        const input = {
          project_ref: project.id,
          operation_id: crypto.randomUUID(),
          action: "delete",
          items: published.map((p) => p.item),
        };
        expect((await service.preview(actor, input)).items[0]).toMatchObject({
          status: "blocked",
          error: { code: "skill_referenced" },
        });
        await expect(
          service.apply({ ...actor, userId: crypto.randomUUID() }, input),
        ).rejects.toMatchObject({ status: 403 });
        expect(
          (
            await service.apply(actor, {
              ...input,
              items: [{ ...first.item, updated_at: first.item.updated_at + 1 }],
            })
          ).items[0],
        ).toMatchObject({
          status: "blocked",
          error: { code: "revision_conflict" },
        });
        release();
        await reading;
        const outside = join(root, "outside");
        await mkdir(outside);
        await writeFile(join(outside, "keep"), "preserved");
        await rename(pendingPkg.path, pendingPkg.path + "-held");
        await symlink(outside, pendingPkg.path);
        const result = await service.apply(actor, input);
        expect(result.items[0]).toMatchObject({
          status: "completed",
          action: "delete",
        });
        expect(result.items[1]).toMatchObject({
          status: "blocked",
          error: { code: "skill_protected" },
        });
        expect(result.items[2]).toMatchObject({ status: "pending_cleanup" });
        await expect(access(first.path)).rejects.toThrow();
        expect(
          (
            await service.apply(actor, {
              ...input,
              operation_id: crypto.randomUUID(),
              action: "restore",
              items: [first.item],
            })
          ).items[0],
        ).toMatchObject({
          status: "blocked",
          error: { code: "skill_unavailable" },
        });
        await expect(
          store.authorizedSkill(actor, first.item.skill_id),
        ).rejects.toMatchObject({ code: "skill_unavailable" });
        expect(await readFile(join(outside, "keep"), "utf8")).toBe("preserved");
        const gc = await storage.db
          .selectFrom("package_gc")
          .selectAll()
          .where("tenant_id", "=", actor.tenantId)
          .where("skill_id", "=", pendingPkg.item.skill_id)
          .executeTakeFirstOrThrow();
        await storage.db
          .updateTable("package_gc")
          .set({ package_path: relative(dataDir, protectedPkg.path) })
          .where("tenant_id", "=", actor.tenantId)
          .where("skill_id", "=", pendingPkg.item.skill_id)
          .execute();
        expect((await service.apply(actor, input)).items[2]).toMatchObject({
          status: "pending_cleanup",
          error: { code: "unsafe_path" },
        });
        await access(protectedPkg.path);
        await storage.db
          .updateTable("package_gc")
          .set({ package_path: gc.package_path })
          .where("tenant_id", "=", actor.tenantId)
          .where("skill_id", "=", pendingPkg.item.skill_id)
          .execute();
        await unlink(pendingPkg.path);
        await rename(pendingPkg.path + "-held", pendingPkg.path);
        // A nested hostile symlink is unlinked without visiting its target.
        await symlink(outside, join(pendingPkg.path, "hostile"));
        const recovery = new DeletionService(storage, dataDir);
        const successor = { ...actor, userId: crypto.randomUUID() };
        await storage.db
          .insertInto("users")
          .values({
            id: successor.userId,
            subject: `fixture|${successor.userId}`,
            display_name: "Successor",
            created_at: now,
          })
          .execute();
        await storage.db
          .insertInto("memberships")
          .values({
            tenant_id: actor.tenantId,
            user_id: successor.userId,
            role: "admin",
          })
          .execute();
        expect(
          (await recovery.pending(successor, project.id)).items.map(
            (i) => i.skill_id,
          ),
        ).toEqual([pendingPkg.item.skill_id]);
        await expect(
          recovery.resume(
            { ...successor, tenantId: crypto.randomUUID() },
            project.id,
            pendingPkg.item.skill_id,
          ),
        ).rejects.toMatchObject({ status: 403 });
        expect(
          await recovery.resume(
            successor,
            project.id,
            pendingPkg.item.skill_id,
          ),
        ).toMatchObject({ status: "completed" });
        expect(
          (await recovery.pending(successor, project.id)).items,
        ).toHaveLength(0);
        const replay = await service.apply(actor, input);
        expect(replay.items[0]).toMatchObject({ status: "completed" });
        expect(replay.items[2]).toMatchObject({ status: "completed" });
        await expect(access(pendingPkg.path)).rejects.toThrow();
        expect(await readFile(join(outside, "keep"), "utf8")).toBe("preserved");
        expect(
          await storage.db
            .selectFrom("audit_events")
            .selectAll()
            .where("tenant_id", "=", actor.tenantId)
            .where("kind", "=", "maintenance.delete")
            .execute(),
        ).toHaveLength(2);
        expect(
          (
            await service.apply(actor, {
              ...input,
              items: [{ ...first.item, revision: "0".repeat(64) }],
            })
          ).items[0],
        ).toMatchObject({
          status: "blocked",
          error: { code: "idempotency_conflict" },
        });
        expect(
          (
            await store.files(
              actor,
              protectedPkg.item.skill_id,
              protectedPkg.item.revision,
            )
          ).files["SKILL.md"]!.length,
        ).toBeGreaterThan(0);
      } finally {
        release();
        await reading?.catch(() => undefined);
        await storage.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    20000,
  );
}
