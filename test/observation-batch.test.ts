import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { observe } from "../src/telemetry/observations.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`observation group commit ${backend}: isolation, idempotency, rollback and bounded admission`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-observation-batch-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    try {
      const identities = new IdentityService(storage.db);
      const actor = await identities.bootstrapLocal();
      const project = await identities.createProject(
        actor,
        "Batch observations",
      );
      const name = `batch-${crypto.randomUUID()}`;
      const pkg = await new PackageStore(storage, root).publish(actor, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Durable observation contract.\n---\n# Test\nPreserve observations.\n`,
          ),
        },
      });
      const item = { skill_id: pkg.skill_id, revision: pkg.revision };
      const call = (key: string, value = item) =>
        observe(storage.db, actor, project.id, "loaded", [value], key);
      const results = await Promise.allSettled([
        call("good-1"),
        call("bad", { ...item, revision: "missing" }),
        call("good-2"),
        call("good-1"),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        "fulfilled",
        "rejected",
        "fulfilled",
        "fulfilled",
      ]);
      const rows = () =>
        storage.db
          .selectFrom("skill_observations")
          .selectAll()
          .where("tenant_id", "=", actor.tenantId)
          .where("project_id", "=", project.id)
          .execute();
      expect((await rows()).map((r) => r.correlation).sort()).toEqual([
        "good-1",
        "good-2",
      ]);
      await expect(
        storage.db.transaction().execute(async (tx) => {
          await observe(tx, actor, project.id, "loaded", [item], "rolled-back");
          throw new Error("rollback sentinel");
        }),
      ).rejects.toThrow("rollback sentinel");
      expect((await rows()).length).toBe(2);
      // Synchronous admission burst cannot grow the queue beyond its fixed cap.
      const burst = await Promise.allSettled(
        Array.from({ length: 129 }, (_, i) => call(`burst-${i}`)),
      );
      expect(burst.filter((r) => r.status === "fulfilled").length).toBe(128);
      const rejected = burst.filter((r) => r.status === "rejected");
      expect(rejected.length).toBe(1);
      expect(
        rejected[0]?.status === "rejected" && rejected[0].reason.code,
      ).toBe("observation_capacity");
      expect((await rows()).length).toBe(130);
      await call("after-capacity");
      expect((await rows()).length).toBe(131);
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
