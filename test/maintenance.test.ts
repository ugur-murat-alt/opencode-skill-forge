import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { ForgeService } from "../src/application/forge.js";
import { PackageManager } from "../src/application/packages.js";
import { MaintenanceService } from "../src/application/maintenance.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`maintenance ${backend}: observations, partial replay, protection race, restore and private scope`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-maintenance-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    try {
      const identity = new IdentityService(storage.db),
        actor = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID() },
        now = Date.now();
      await storage.db
        .insertInto("tenants")
        .values({
          id: actor.tenantId,
          name: "Isolated maintenance fixture",
          created_at: now,
        })
        .execute();
      await storage.db
        .insertInto("users")
        .values({
          id: actor.userId,
          subject: `fixture|${actor.userId}`,
          display_name: "Maintenance owner",
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
      const project = await identity.createProject(actor, "Maintenance test");
      const forge = new ForgeService(storage, root, "test-only-signing-key"),
        manager = new PackageManager(forge.packages),
        service = new MaintenanceService(storage);
      const published = [];
      for (let i = 0; i < 3; i++) {
        const name = `maintenance-${i}-${crypto.randomUUID()}`;
        published.push(
          await forge.packages.publish(actor, {
            name,
            scope: "project",
            projectId: project.id,
            baseRevision: null,
            files: {
              "SKILL.md": Buffer.from(
                `---\nname: ${name}\ndescription: Maintenance contract fixture\n---\nKeep the verified method.`,
              ),
            },
          }),
        );
      }
      const [first, protectedSkill, changed] = published;
      await forge.invoke("forge_search", actor, {
        project_ref: project.id,
        query: "maintenance",
        limit: 20,
      });
      await forge.invoke("forge_load", actor, {
        project_ref: project.id,
        skill_id: first!.skill_id,
        revision: first!.revision,
      });
      await manager.configure(actor, protectedSkill!.skill_id, {
        base_revision: protectedSkill!.revision,
        protected: true,
      });
      await expect(
        manager.configure(actor, protectedSkill!.skill_id, {
          base_revision: protectedSkill!.revision,
          archived: true,
        }),
      ).rejects.toMatchObject({ code: "skill_protected" });
      const oldSettings = await forge.packages.authorizedSkill(
        actor,
        protectedSkill!.skill_id,
      );
      await manager.configure(actor, protectedSkill!.skill_id, {
        base_revision: protectedSkill!.revision,
        base_updated_at: oldSettings.updated_at,
        pinned: true,
      });
      await expect(
        manager.configure(actor, protectedSkill!.skill_id, {
          base_revision: protectedSkill!.revision,
          base_updated_at: oldSettings.updated_at,
          pinned: false,
        }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      const report = await service.report(actor, project.id);
      const toolReport = await forge.invoke("forge_report", actor, {
        project_ref: project.id,
        section: "maintenance",
      });
      expect(toolReport.items).toEqual(report.items);
      const page = await forge.invoke("forge_report", actor, {
        project_ref: project.id,
        section: "maintenance",
        limit: 1,
      });
      const pageTwo = await forge.invoke("forge_report", actor, {
        project_ref: project.id,
        section: "maintenance",
        limit: 1,
        cursor: page.next_cursor,
      });
      expect(pageTwo.items[0].skill_id).not.toBe(page.items[0].skill_id);
      await expect(
        forge.invoke("forge_report", actor, {
          project_ref: project.id,
          section: "jobs",
          limit: 1,
          cursor: page.next_cursor,
        }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
      const observed = report.items.find(
        (i) => i.skill_id === first!.skill_id,
      )!;
      expect(observed.observations.loaded!.count).toBe(1);
      expect(observed.observations.search_impression!.count).toBe(1);
      expect(observed.outcome_observed).toBeNull();
      expect(observed.reported_applied).toBeNull();
      expect(report.external_usage).toBe("unknown");
      expect(observed.reason).toBe("new_skill_grace");
      const request = {
        project_ref: project.id,
        operation_id: "batch-one",
        action: "archive",
        items: report.items.map(({ skill_id, revision, updated_at }) => ({
          skill_id,
          revision,
          updated_at,
        })),
      };
      expect(
        (await service.preview(actor, request)).items.filter(
          (i) => i.status === "blocked",
        ),
      ).toHaveLength(1);
      // Protect another item after preview: no stale authorization to archive it.
      await manager.configure(actor, changed!.skill_id, {
        base_revision: changed!.revision,
        pinned: true,
      });
      const applied = await service.apply(actor, request);
      expect(
        applied.items.filter((i) => i.status === "completed"),
      ).toHaveLength(1);
      expect(applied.items.filter((i) => i.status === "blocked")).toHaveLength(
        2,
      );
      const again = await service.apply(actor, request);
      expect(again.items.find((i) => i.status === "completed").replayed).toBe(
        true,
      );
      expect(
        (await forge.packages.files(actor, first!.skill_id, first!.revision))
          .files["SKILL.md"],
      ).toBeDefined();
      expect(
        (
          await forge.packages.search(actor, { projectId: project.id })
        ).items.some((i) => i.skill_id === first!.skill_id),
      ).toBe(false);
      const archived = (
        await service.report(actor, project.id, { state: "archived" })
      ).items;
      expect(archived).toHaveLength(1);
      const restore = {
        project_ref: project.id,
        operation_id: "restore-one",
        action: "restore",
        items: archived.map(({ skill_id, revision, updated_at }) => ({
          skill_id,
          revision,
          updated_at,
        })),
      };
      expect((await service.apply(actor, restore)).items[0].status).toBe(
        "completed",
      );
      expect(
        (
          await forge.packages.search(actor, { projectId: project.id })
        ).items.some((i) => i.skill_id === first!.skill_id),
      ).toBe(true);
      const other = await identity.createProject(actor, "Other project");
      expect((await service.report(actor, other.id)).items).toHaveLength(0);
      expect(
        (
          await service.apply(actor, { ...request, project_ref: other.id })
        ).items.every((i) => i.status === "blocked"),
      ).toBe(true);
      await expect(
        service.report({ ...actor, tenantId: "foreign" }, project.id),
      ).rejects.toMatchObject({ status: 403 });
      const receipt = await storage.db
        .selectFrom("maintenance_items")
        .selectAll()
        .where("project_id", "=", project.id)
        .execute();
      expect(receipt).toHaveLength(2);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
}
