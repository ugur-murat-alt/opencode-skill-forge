import { JobQueue } from "../src/jobs/queue.js";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemberService } from "../src/application/members.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
])
  test(`members ${backend}: revocation, stale update, project ceiling, protected owner and reenable`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-members-")),
      storage = await openDatabase({
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
    try {
      const identity = new IdentityService(storage.db),
        owner = await identity.bootstrapLocal(),
        project = await identity.createProject(owner, "Members contract"),
        service = new MemberService(storage.db);
      const subject = `fixture|${crypto.randomUUID()}`,
        added = await service.create(owner, {
          subject,
          display_name: "Contract viewer",
          role: "viewer",
        }),
        actor = { ...owner, userId: added.user_id };
      const token = await identity.issueSession(actor.userId, "session", 60000);
      const request = {
        project_ref: project.id,
        generation: 0,
        project_generation: null,
        role: "viewer",
        disabled: false,
        project_role: "editor",
      };
      await service.update(owner, actor.userId, request);
      expect(await identity.authorize(actor, "read", project.id)).toBe(
        "viewer",
      );
      await expect(
        identity.authorize(actor, "write", project.id),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.update(owner, actor.userId, request),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(service.list(actor, project.id)).rejects.toMatchObject({
        status: 403,
      });
      await service.update(owner, actor.userId, {
        ...request,
        generation: 1,
        project_generation: 0,
        role: "editor",
        disabled: false,
      });
      const queue = new JobQueue(storage);
      const accepted = await queue.accept(actor, {
        projectId: project.id,
        kind: "skill_evolve",
        key: "before-revocation",
        payload: { summary: "Verified fixture" },
      });
      const running = await queue.claim(
        "revocation-worker",
        15000,
        "skill_evolve",
        { tenantId: owner.tenantId, runId: accepted.run.id },
      );
      expect(running).not.toBeNull();
      await service.update(owner, actor.userId, {
        ...request,
        generation: 2,
        project_generation: 1,
        role: "editor",
        disabled: true,
      });
      const cancelled = await storage.db
        .selectFrom("runs")
        .select(["state", "error_code"])
        .where("id", "=", accepted.run.id)
        .executeTakeFirstOrThrow();
      expect(cancelled).toEqual({
        state: "cancelled",
        error_code: "permission_revoked",
      });
      await expect(
        queue.finish(running!, "completed", { decision: "create" }),
      ).rejects.toMatchObject({ code: "stale_worker" });
      await expect(
        identity.authenticate(token, owner.tenantId),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        identity.authorize(actor, "read", project.id),
      ).rejects.toMatchObject({ status: 403 });
      const current = (await service.list(owner, project.id)).items.find(
        (m) => m.user_id === actor.userId,
      )!;
      await service.update(owner, actor.userId, {
        ...request,
        generation: current.generation,
        project_generation: current.project_generation,
        role: "editor",
        disabled: false,
      });
      expect(await identity.authorize(actor, "write", project.id)).toBe(
        "editor",
      );
      await expect(
        service.update(owner, owner.userId, request),
      ).rejects.toMatchObject({ code: "owner_protected" });
      expect(
        (
          await service.create(owner, {
            subject,
            display_name: "ignored",
            role: "admin",
          })
        ).created,
      ).toBe(false);
      expect(await identity.authorize(actor, "read", project.id)).toBe(
        "editor",
      );
      await expect(
        service.list({ ...owner, tenantId: "foreign" }, project.id),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
