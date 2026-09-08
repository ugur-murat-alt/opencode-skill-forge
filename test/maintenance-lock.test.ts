import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
import { PackageStore } from "../src/skills/store.js";
import { MaintenanceService } from "../src/application/maintenance.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  for (const action of ["archive", "restore"] as const) {
    test(`maintenance ${backend} ${action}: project revocation serializes before item writes`, async () => {
      const root = await mkdtemp(join(tmpdir(), "forge-maintenance-lock-"));
      const storage = await openDatabase({
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
      const maintenance = new MaintenanceService(storage);
      let pending: ReturnType<typeof maintenance.apply> | undefined;
      try {
        const auth = new IdentityService(storage.db),
          owner = await auth.bootstrapLocal();
        const project = await auth.createProject(owner, "Maintenance lock");
        const member = await new MemberService(storage.db).create(owner, {
          subject: `fixture|${crypto.randomUUID()}`,
          display_name: "Maintenance editor",
          role: "writer",
        });
        const actor = { ...owner, userId: member.user_id };
        const grant = {
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          project_id: project.id,
          role: "writer" as const,
        };
        await storage.db.insertInto("project_members").values(grant).execute();
        const packages = new PackageStore(storage, root),
          name = `lock-${crypto.randomUUID()}`;
        const published = await packages.publish(actor, {
          name,
          scope: "project",
          projectId: project.id,
          baseRevision: null,
          files: {
            "SKILL.md": Buffer.from(
              `---\nname: ${name}\ndescription: Bakım yarışının gerçek paket doğrulaması.\n---\n# Yöntem\nYetki iptalinden sonra paket değişmemelidir.\n`,
            ),
          },
        });
        if (action === "restore")
          await storage.db
            .updateTable("skills")
            .set({ archived: 1 })
            .where("tenant_id", "=", actor.tenantId)
            .where("id", "=", published.skill_id)
            .execute();
        const before = await packages.authorizedSkill(
          actor,
          published.skill_id,
        );
        const input = {
          project_ref: project.id,
          operation_id: crypto.randomUUID(),
          action,
          items: [
            {
              skill_id: before.id,
              revision: before.active_revision!,
              updated_at: before.updated_at,
            },
          ],
        };
        expect((await maintenance.preview(actor, input)).items[0]!.status).toBe(
          "eligible",
        );
        await storage.db.transaction().execute(async (tx) => {
          await tx
            .updateTable("tenants")
            .set({ name: sql`name` })
            .where("id", "=", actor.tenantId)
            .execute();
          if (backend === "postgres") {
            const pid = (
              await sql<{
                pid: number;
              }>`select pg_backend_pid() as pid`.execute(tx)
            ).rows[0]!.pid;
            pending = maintenance.apply(actor, input);
            let blocked = false;
            const deadline = Date.now() + 3000;
            while (!blocked && Date.now() < deadline) {
              blocked = (
                await sql<{
                  blocked: boolean;
                }>`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocked`.execute(
                  storage.db,
                )
              ).rows[0]!.blocked;
              if (!blocked)
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(blocked).toBe(true);
          }
          await tx
            .deleteFrom("project_members")
            .where("tenant_id", "=", actor.tenantId)
            .where("user_id", "=", actor.userId)
            .where("project_id", "=", project.id)
            .execute();
        });
        if (pending)
          expect((await pending).items[0]).toMatchObject({
            status: "blocked",
            error: { code: "forbidden" },
          });
        await expect(maintenance.apply(actor, input)).rejects.toMatchObject({
          status: 403,
        });
        const after = await packages.authorizedSkill(owner, before.id);
        expect(after.archived).toBe(before.archived);
        expect(after.updated_at).toBe(before.updated_at);
        expect(
          await storage.db
            .selectFrom("maintenance_items")
            .selectAll()
            .where("tenant_id", "=", actor.tenantId)
            .where("operation_id", "=", input.operation_id)
            .execute(),
        ).toHaveLength(0);
        expect(
          await storage.db
            .selectFrom("audit_events")
            .selectAll()
            .where("tenant_id", "=", actor.tenantId)
            .where("project_id", "=", project.id)
            .where("kind", "=", `maintenance.${action}`)
            .execute(),
        ).toHaveLength(0);
        await storage.db.insertInto("project_members").values(grant).execute();
        expect((await maintenance.apply(actor, input)).items[0]).toMatchObject({
          status: "completed",
          action,
        });
        expect((await maintenance.apply(actor, input)).items[0]).toMatchObject({
          status: "completed",
          replayed: true,
        });
      } finally {
        await pending?.catch(() => undefined);
        await storage.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 15000);
  }
}
