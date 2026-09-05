import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
import { LearningStore } from "../src/prompt/learning.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`learning deletion ${backend}: revocation serializes before removal and preserves history`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-learning-delete-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    try {
      const auth = new IdentityService(storage.db),
        owner = await auth.bootstrapLocal();
      const project = await auth.createProject(owner, "Learning deletion");
      const member = await new MemberService(storage.db).create(owner, {
        subject: `fixture|${crypto.randomUUID()}`,
        display_name: "Learning author",
        role: "editor",
      });
      const actor = { ...owner, userId: member.user_id };
      const grant = {
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        project_id: project.id,
        role: "editor" as const,
      };
      await storage.db.insertInto("project_members").values(grant).execute();
      const learning = new LearningStore(storage);
      const lesson = await learning.save(actor, project.id, {
        content: "Preserve explicit quantities and constraints.",
        triggers: "quantities",
      });
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      await storage.db.transaction().execute(async (tx) => {
        await tx
          .updateTable("tenants")
          .set({ name: sql`name` })
          .where("id", "=", actor.tenantId)
          .execute();
        if (backend === "postgres") {
          const pid = (
            await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
              tx,
            )
          ).rows[0]!.pid;
          pending = Promise.allSettled([
            learning.remove(actor, project.id, lesson.id),
          ]);
          let blocked = false;
          const deadline = Date.now() + 3000;
          while (!blocked && Date.now() < deadline) {
            const waiters = await sql<{
              blocked: boolean;
            }>`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocked`.execute(
              storage.db,
            );
            blocked = waiters.rows[0]!.blocked;
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
      if (pending) {
        const outcome = (await pending)[0]!;
        expect(outcome.status).toBe("rejected");
        expect((outcome as PromiseRejectedResult).reason.status).toBe(403);
      }
      await expect(
        learning.remove(actor, project.id, lesson.id),
      ).rejects.toMatchObject({ status: 403 });
      const count = async (table: "learning_entries" | "learning_history") => {
        const row = await storage.db
          .selectFrom(table)
          .select(sql<number>`count(*)`.as("n"))
          .where("tenant_id", "=", actor.tenantId)
          .where(
            table === "learning_entries" ? "id" : "entry_id",
            "=",
            lesson.id,
          )
          .executeTakeFirstOrThrow();
        return Number(row.n);
      };
      expect(await count("learning_entries")).toBe(1);
      expect(await count("learning_history")).toBe(1);
      await storage.db.insertInto("project_members").values(grant).execute();
      await learning.remove(actor, project.id, lesson.id);
      expect(await count("learning_entries")).toBe(0);
      expect(await count("learning_history")).toBe(0);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}
