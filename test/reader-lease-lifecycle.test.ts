import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import {
  PackageStore,
  type PackageStoreLiveness,
} from "../src/skills/store.js";
import { MaintenanceService } from "../src/application/maintenance.js";
import { DeletionService } from "../src/application/deletion.js";

async function archivedPackage(root: string, liveness?: PackageStoreLiveness) {
  const storage = await openDatabase({ dataDir: root });
  const actor = await new IdentityService(storage.db).bootstrapLocal();
  const project = await new IdentityService(storage.db).createProject(
    actor,
    "Reader lease",
  );
  const store = new PackageStore(storage, root, undefined, {}, liveness);
  const name = `reader-lease-${randomUUID().slice(0, 8)}`;
  const pkg = await store.publish(actor, {
    name,
    scope: "project",
    projectId: project.id,
    baseRevision: null,
    files: {
      "SKILL.md": Buffer.from(
        `---\nname: ${name}\ndescription: Reader lease lifecycle acceptance.\n---\nBody.\n`,
      ),
    },
  });
  const loaded = await store.files(actor, pkg.skill_id, pkg.revision);
  await new MaintenanceService(storage, root).apply(actor, {
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
  return {
    storage,
    actor,
    project,
    store,
    skillId: pkg.skill_id,
    revision: pkg.revision,
  };
}

/** DELETE çalışmadan hemen önce pin'i yeniler: sweep seçimi ile silme arasındaki yarış. */
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

/** Belirli bir tablo/çağrı için hata enjekte eder; diğer çağrılar gerçek DB'ye gider. */
function failingDelete(
  storage: DatabaseHandle,
  table: string,
  failures: number,
): DatabaseHandle {
  let remaining = failures;
  const target = storage.db as unknown as Record<string | symbol, unknown>;
  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(current, prop) {
        if (prop === "execute")
          return async () => {
            if (remaining > 0) {
              remaining--;
              throw new Error(`enjekte edilen ${table} silme hatası`);
            }
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
        return (name: string) =>
          table === name
            ? wrap(
                (
                  current as { deleteFrom: (tableName: string) => object }
                ).deleteFrom(name),
              )
            : (
                current as { deleteFrom: (tableName: string) => object }
              ).deleteFrom(name);
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    },
  }) as unknown as DatabaseHandle["db"];
  return { ...storage, db };
}

function failingUpdates(
  storage: DatabaseHandle,
  table: string,
): DatabaseHandle {
  const target = storage.db as unknown as Record<string | symbol, unknown>;
  const wrap = (builder: object): object =>
    new Proxy(builder, {
      get(current, prop) {
        if (prop === "execute")
          return async () => {
            throw new Error(`enjekte edilen ${table} güncelleme hatası`);
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
      if (prop === "updateTable")
        return (name: string) => {
          const builder = (
            current as { updateTable: (tableName: string) => object }
          ).updateTable(name);
          return table === name ? wrap(builder) : builder;
        };
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    },
  }) as unknown as DatabaseHandle["db"];
  return { ...storage, db };
}

test("P2 #27 expired selection and DELETE re-check: a pin renewed in between survives, the dead one clears", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-lease-barrier-"));
  const { storage, actor, store, skillId, revision } =
    await archivedPackage(root);
  try {
    const dbNow = await storage.now();
    const insertPin = (owner: string) =>
      storage.db
        .insertInto("revision_readers")
        .values({
          tenant_id: actor.tenantId,
          id: randomUUID(),
          skill_id: skillId,
          revision,
          created_at: dbNow - 10_000,
          owner,
          expires_at: dbNow - 5_000,
        })
        .execute();
    await insertPin("live-generation");
    await insertPin("dead-generation");
    let renewed = false;
    const sweeping = new PackageStore(
      withReaderDeleteBarrier(storage, async () => {
        if (renewed) return;
        renewed = true;
        await storage.db
          .updateTable("revision_readers")
          .set({ expires_at: dbNow + 60_000 })
          .where("tenant_id", "=", actor.tenantId)
          .where("owner", "=", "live-generation")
          .execute();
      }),
      root,
    );
    const result = await sweeping.reconcile(actor);
    expect(renewed).toBe(true);
    // Re-checked DELETE koşulu yalnız gerçekten süresi geçmiş satırı siler.
    expect(result.cleared_readers).toBe(1);
    const live = await storage.db
      .selectFrom("revision_readers")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("owner", "=", "live-generation")
      .executeTakeFirst();
    expect(live).toBeDefined();
    expect(live!.expires_at).toBeGreaterThan(await storage.now());
    const dead = await storage.db
      .selectFrom("revision_readers")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("owner", "=", "dead-generation")
      .executeTakeFirst();
    expect(dead).toBeUndefined();
    const again = await store.reconcile(actor);
    expect(again.cleared_readers).toBe(0);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #27 integrity scan pins are owned and expiring; a failed cleanup is recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-lease-integrity-"));
  const { storage, actor } = await archivedPackage(root, { leaseMs: 250 });
  try {
    const isolated = new PackageStore(
      failingDelete(storage, "revision_readers", 1),
      root,
      undefined,
      {},
      { leaseMs: 250 },
    );
    // Temizlik hatası raporu düşürmez; sahipli pin kalır ve sonraki sweep kurtarır.
    const report = await isolated.reconcile(actor);
    expect(report.issues).toEqual([]);
    const pins = await storage.db
      .selectFrom("revision_readers")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("kind", "=", "integrity")
      .execute();
    expect(pins.length).toBeGreaterThanOrEqual(1);
    for (const pin of pins) {
      expect(pin.owner).toBe(isolated.generation);
      expect(pin.expires_at).not.toBeNull();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const recovered = await new PackageStore(
      storage,
      root,
      undefined,
      {},
      {
        leaseMs: 250,
      },
    ).reclaim(actor);
    expect(recovered.cleared_readers).toBeGreaterThanOrEqual(pins.length);
    expect(
      await storage.db
        .selectFrom("revision_readers")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("kind", "=", "integrity")
        .execute(),
    ).toEqual([]);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #27 reader expiry uses database time; a skewed application clock cannot expire a live pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-lease-skew-"));
  const { storage, actor, project, store, skillId, revision } =
    await archivedPackage(root, { leaseMs: 3_000 });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() - 3_600_000;
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reading = store.withRevision(actor, skillId, revision, async () => {
      holding.resolve();
      await release.promise;
      return "read-complete";
    });
    await holding.promise;
    const dbNow = await storage.now();
    const pin = await storage.db
      .selectFrom("revision_readers")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("owner", "=", store.generation)
      .executeTakeFirstOrThrow();
    // expires_at uygulama saatiyle değil DB saatiyle üretilir.
    expect(pin.expires_at! - dbNow).toBeGreaterThan(1_500);
    const reconciled = await store.reconcile(actor);
    expect(reconciled.cleared_readers).toBe(0);
    const blocked = await new DeletionService(storage, root).preview(actor, {
      project_ref: project.id,
      operation_id: randomUUID(),
      action: "delete",
      items: [
        {
          skill_id: skillId,
          revision,
          updated_at: (await store.authorizedSkill(actor, skillId)).updated_at,
        },
      ],
    });
    expect(blocked.items[0]).toMatchObject({
      status: "blocked",
      error: { code: "skill_referenced" },
    });
    release.resolve();
    await expect(reading).resolves.toBe("read-complete");
  } finally {
    Date.now = realNow;
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #27 active heartbeat keeps a real read alive; ownerless backup pins survive and need an explicit cutoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-lease-active-"));
  const { storage, actor, project, store, skillId, revision } =
    await archivedPackage(root, { leaseMs: 300 });
  try {
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reading = store.withRevision(actor, skillId, revision, async () => {
      holding.resolve();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await release.promise;
      return "live";
    });
    await holding.promise;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const liveSweep = await store.reconcile(actor);
    expect(liveSweep.cleared_readers).toBe(0);
    const pin = await storage.db
      .selectFrom("revision_readers")
      .selectAll()
      .where("tenant_id", "=", actor.tenantId)
      .where("owner", "=", store.generation)
      .executeTakeFirstOrThrow();
    expect(pin.kind).toBe("read");
    expect(pin.expires_at).toBeGreaterThan(await storage.now());
    // Sahipsiz (yedek) pin'ler rutin süpürmeyle asla silinmez.
    const dbNow = await storage.now();
    const ownerlessId = randomUUID();
    await storage.db
      .insertInto("revision_readers")
      .values({
        tenant_id: actor.tenantId,
        id: ownerlessId,
        skill_id: skillId,
        revision,
        created_at: dbNow - 100_000,
        kind: "backup",
        owner: null,
        expires_at: null,
      })
      .execute();
    const ownerlessSweep = await store.reconcile(actor);
    expect(ownerlessSweep.cleared_readers).toBe(0);
    expect(ownerlessSweep.reclaimed_ownerless).toBe(0);
    expect(
      await storage.db
        .selectFrom("revision_readers")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", ownerlessId)
        .executeTakeFirst(),
    ).toBeDefined();
    // Açık yönetici kesimi eski sahipsiz kaydı kurtarır; yeni kayıt korunur.
    const explicit = await store.reclaim(actor, {
      recoverOwnerlessBefore: dbNow - 50_000,
    });
    expect(explicit.reclaimed_ownerless).toBe(1);
    expect(
      await storage.db
        .selectFrom("revision_readers")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", ownerlessId)
        .executeTakeFirst(),
    ).toBeUndefined();
    const recentId = randomUUID();
    await storage.db
      .insertInto("revision_readers")
      .values({
        tenant_id: actor.tenantId,
        id: recentId,
        skill_id: skillId,
        revision,
        created_at: await storage.now(),
        kind: "backup",
        owner: null,
        expires_at: null,
      })
      .execute();
    expect((await store.reclaim(actor, {})).reclaimed_ownerless).toBe(0);
    expect(
      await storage.db
        .selectFrom("revision_readers")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("id", "=", recentId)
        .executeTakeFirst(),
    ).toBeDefined();
    await expect(
      store.reclaim(actor, { recoverOwnerlessBefore: dbNow + 3_600_000 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    release.resolve();
    await expect(reading).resolves.toBe("live");
    // Okuma bittiğinde kendi pin'i temizlenir.
    expect(
      await storage.db
        .selectFrom("revision_readers")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("owner", "=", store.generation)
        .executeTakeFirst(),
    ).toBeUndefined();
    void project;
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #27 an unverifiable heartbeat cancels result acceptance instead of returning data", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-lease-heartbeat-"));
  const { storage, actor, store, skillId, revision } = await archivedPackage(
    root,
    { leaseMs: 300 },
  );
  try {
    const isolated = new PackageStore(
      failingUpdates(storage, "revision_readers"),
      root,
      undefined,
      {},
      { leaseMs: 300 },
    );
    let readFinished = false;
    await expect(
      isolated.withRevision(actor, skillId, revision, async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        readFinished = true;
        return "stale-data";
      }),
    ).rejects.toMatchObject({ code: "reader_closed" });
    // I/O tamamlanmış olsa bile sonuç kabul edilmedi.
    expect(readFinished).toBe(true);
    void store;
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
