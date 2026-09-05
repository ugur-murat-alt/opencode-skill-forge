import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { JobQueue } from "../src/jobs/queue.js";
import { PackageStore } from "../src/skills/store.js";
import { EvolutionStaging } from "../src/runner/staging.js";
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
]) {
  test(`SPR pin ${backend}: durable base, FK, stale select, fence-isolated disposal`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-run-pin-"));
    const storage = await openDatabase({
      dataDir: root,
      ...(backend === "postgres"
        ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
        : {}),
    });
    const stages: EvolutionStaging[] = [];
    let releaseRead = () => {};
    let selected: Promise<unknown> | undefined;
    try {
      const auth = new IdentityService(storage.db),
        owner = await auth.bootstrapLocal(),
        project = await auth.createProject(owner, "Run pins");
      const store = new PackageStore(storage, root),
        queue = new JobQueue(storage),
        name = `pin-${crypto.randomUUID()}`;
      const pkg = await store.publish(owner, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Sabit taban revision koruması.\n---\n# Yöntem\nPaket revizyonunu iş boyunca koru.\n`,
          ),
        },
      });
      const accepted = await queue.accept(owner, {
        projectId: project.id,
        kind: "skill_evolve",
        key: crypto.randomUUID(),
        payload: { summary: "verified" },
      });
      const target = { tenantId: owner.tenantId, runId: accepted.run.id };
      const first = (await queue.claim(
        "old-pin-worker",
        30000,
        "skill_evolve",
        target,
      ))!;
      const old = new EvolutionStaging(store, owner, first);
      stages.push(old);
      const call = (stage: EvolutionStaging, tool: string, args: object) =>
        stage
          .tools()
          .find((t) => t.name === tool)!
          .execute("fixture", args);
      const select = { name, scope: "project", skill_id: pkg.skill_id };
      await call(old, "inventory", { query: name });
      const originalFiles = store.files.bind(store);
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let firstRead = true;
      store.files = async (...args) => {
        if (firstRead) {
          firstRead = false;
          entered();
          await gate;
        }
        return originalFiles(...args);
      };
      selected = call(old, "select", select);
      await reading;
      const pins = () =>
        storage.db
          .selectFrom("run_revision_pins")
          .selectAll()
          .where("tenant_id", "=", owner.tenantId)
          .where("run_id", "=", first.id)
          .orderBy("fence")
          .execute();
      expect(await pins()).toHaveLength(1);
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
      await storage.db
        .updateTable("runs")
        .set({ lease_until: 0 })
        .where("tenant_id", "=", owner.tenantId)
        .where("id", "=", first.id)
        .execute();
      const second = (await queue.claim(
        "new-pin-worker",
        30000,
        "skill_evolve",
        target,
      ))!;
      expect(second.fence).toBeGreaterThan(first.fence);
      const stale = new EvolutionStaging(store, owner, first);
      stages.push(stale);
      await call(stale, "inventory", { query: name });
      await expect(call(stale, "select", select)).rejects.toMatchObject({
        code: "stale_worker",
      });
      const next = new EvolutionStaging(store, owner, second);
      stages.push(next);
      await call(next, "inventory", { query: name });
      await call(next, "select", select);
      expect(await pins()).toHaveLength(2);
      let disposed = false;
      const disposal = old.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(disposed).toBe(false);
      expect(await pins()).toHaveLength(2);
      releaseRead();
      await selected;
      await disposal;
      await old.dispose();
      expect((await pins()).map((p) => p.fence)).toEqual([second.fence]);
      await queue.cancel(owner, second.id);
      expect(await pins()).toHaveLength(1);
      await next.dispose();
      expect(await pins()).toHaveLength(0);
      await expect(
        call(next, "read", { path: "SKILL.md" }),
      ).rejects.toMatchObject({ code: "run_closed" });
    } finally {
      releaseRead();
      await selected?.catch(() => undefined);
      for (const stage of stages) await stage.dispose();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}
