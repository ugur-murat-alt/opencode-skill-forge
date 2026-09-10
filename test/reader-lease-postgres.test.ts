import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { PackageStore } from "../src/skills/store.js";
import { MaintenanceService } from "../src/application/maintenance.js";

/** DELETE çalışmadan hemen önce pin'i yeniler (seçim/silme yarışı). */
function withReaderDeleteBarrier(
  storage: DatabaseHandle,
  beforeDelete: () => Promise<void>,
): DatabaseHandle {
  const target = storage.db as unknown as Record<string | symbol, unknown>;
  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(current, prop) {
        if (prop === "execute")
          return async () => {
            await beforeDelete();
            return (current as { execute: () => Promise<unknown> }).execute();
          };
        const value = (current as Record<string | symbol, unknown>)[prop];
        return typeof value === "function"
          ? (...args: unknown[]) =>
              wrap(
                (value as (...inner: unknown[]) => object).apply(current, args),
              )
          : value;
      },
    });
  const db = new Proxy(target, {
    get(current, prop) {
      if (prop === "deleteFrom")
        return (table: string) => {
          const builder = (
            current as { deleteFrom: (name: string) => object }
          ).deleteFrom(table);
          return table === "revision_readers" ? wrap(builder) : builder;
        };
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    },
  }) as unknown as DatabaseHandle["db"];
  return { ...storage, db };
}

test.skipIf(!process.env.FORGE_TEST_POSTGRES_URL)(
  "P2 #27 postgres: real heartbeat, re-checked expiry and explicit ownerless recovery",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-lease-pg-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    const storage = await openDatabase({
      dataDir,
      postgresUrl: process.env.FORGE_TEST_POSTGRES_URL,
    });
    try {
      const actor = { tenantId: randomUUID(), userId: randomUUID() };
      const now = Date.now();
      await storage.db
        .insertInto("tenants")
        .values({ id: actor.tenantId, name: "PG lease", created_at: now })
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
          role: "founder",
        })
        .execute();
      const identities = new IdentityService(storage.db);
      const project = await identities.createProject(actor, "PG lease");
      const store = new PackageStore(
        storage,
        dataDir,
        undefined,
        {},
        {
          leaseMs: 400,
        },
      );
      const name = `pg-lease-${randomUUID().slice(0, 8)}`;
      const pkg = await store.publish(actor, {
        name,
        scope: "project",
        projectId: project.id,
        baseRevision: null,
        files: {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: PostgreSQL reader lease acceptance.\n---\nBody.\n`,
          ),
        },
      });
      const loaded = await store.files(actor, pkg.skill_id, pkg.revision);
      await new MaintenanceService(storage, dataDir).apply(actor, {
        project_ref: project.id,
        operation_id: randomUUID(),
        action: "archive",
        items: [
          {
            skill_id: pkg.skill_id,
            revision: pkg.revision,
            updated_at: loaded.skill.updated_at,
          },
        ],
      });
      // 1) Gerçek heartbeat canlı pin'i korur.
      const holding = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const reading = store.withRevision(
        actor,
        pkg.skill_id,
        pkg.revision,
        async () => {
          holding.resolve();
          await release.promise;
          return "live-pg";
        },
      );
      await holding.promise;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const liveSweep = await store.reconcile(actor);
      expect(liveSweep.cleared_readers).toBe(0);
      expect(
        await storage.db
          .selectFrom("revision_readers")
          .select(["kind", "owner", "expires_at"])
          .where("tenant_id", "=", actor.tenantId)
          .where("owner", "=", store.generation)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ kind: "read" });
      // 2) Seçim ile DELETE arasında yenilenen pin silinmez.
      const dbNow = await storage.now();
      const insertPin = (owner: string) =>
        storage.db
          .insertInto("revision_readers")
          .values({
            tenant_id: actor.tenantId,
            id: randomUUID(),
            skill_id: pkg.skill_id,
            revision: pkg.revision,
            created_at: dbNow - 10_000,
            owner,
            expires_at: dbNow - 5_000,
          })
          .execute();
      await insertPin("pg-live");
      await insertPin("pg-dead");
      let renewed = false;
      const sweeping = new PackageStore(
        withReaderDeleteBarrier(storage, async () => {
          if (renewed) return;
          renewed = true;
          await storage.db
            .updateTable("revision_readers")
            .set({ expires_at: dbNow + 60_000 })
            .where("tenant_id", "=", actor.tenantId)
            .where("owner", "=", "pg-live")
            .execute();
        }),
        dataDir,
        undefined,
        {},
        { leaseMs: 400 },
      );
      const barrier = await sweeping.reconcile(actor);
      expect(renewed).toBe(true);
      expect(barrier.cleared_readers).toBe(1);
      expect(
        await storage.db
          .selectFrom("revision_readers")
          .select("id")
          .where("tenant_id", "=", actor.tenantId)
          .where("owner", "=", "pg-live")
          .executeTakeFirst(),
      ).toBeDefined();
      // 3) Sahipsiz kayıt yalnız açık kesimle kurtarılır.
      const ownerlessId = randomUUID();
      await storage.db
        .insertInto("revision_readers")
        .values({
          tenant_id: actor.tenantId,
          id: ownerlessId,
          skill_id: pkg.skill_id,
          revision: pkg.revision,
          created_at: dbNow - 100_000,
          kind: "backup",
          owner: null,
          expires_at: null,
        })
        .execute();
      expect((await store.reconcile(actor)).cleared_readers).toBe(0);
      const recovered = await store.reclaim(actor, {
        recoverOwnerlessBefore: dbNow - 50_000,
      });
      expect(recovered.reclaimed_ownerless).toBe(1);
      release.resolve();
      await expect(reading).resolves.toBe("live-pg");
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
