import { test, expect } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import {
  PackageStore,
  type PackageStoreLiveness,
} from "../src/skills/store.js";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";

const stale = new Date(Date.now() - 60 * 60 * 1000);
const tenantHash = (tenantId: string) =>
  createHash("sha256").update(tenantId).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Lexicographic continuation testi için tüm canlı isimlerden büyük 64-hex isim. */
function nameAbove(names: string[]): string {
  const digits = "0123456789abcdef";
  const chars = [...names.slice().sort().at(-1)!];
  for (let index = chars.length - 1; index >= 0; index--) {
    const next = digits.indexOf(chars[index]!) + 1;
    if (next < digits.length) {
      chars[index] = digits[next]!;
      for (let tail = index + 1; tail < chars.length; tail++) chars[tail] = "0";
      return chars.join("");
    }
  }
  return "f".repeat(64);
}

async function fixture(root: string, liveness?: PackageStoreLiveness) {
  const storage = await openDatabase({ dataDir: root });
  const actor = await new IdentityService(storage.db).bootstrapLocal();
  const project = await new IdentityService(storage.db).createProject(
    actor,
    "File lifecycle",
  );
  const store = new PackageStore(storage, root, undefined, {}, liveness);
  return { storage, actor, project, store };
}

async function revisionsDirOf(
  storage: Awaited<ReturnType<typeof openDatabase>>,
  root: string,
  tenantId: string,
  skillId: string,
) {
  const row = await storage.db
    .selectFrom("skill_revisions")
    .select("package_path")
    .where("tenant_id", "=", tenantId)
    .where("skill_id", "=", skillId)
    .limit(1)
    .executeTakeFirstOrThrow();
  return join(root, dirname(dirname(row.package_path)));
}

test("P2 #28 bounded reclaim passes live records and reaches a later orphan in multiple rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gc-continuation-"));
  const { storage, actor, project, store } = await fixture(root, {
    reclaimBudget: 8,
    reclaimGraceMs: 30,
    leaseMs: 60_000,
  });
  try {
    const name = `continuation-${randomUUID().slice(0, 8)}`;
    let base: string | null = null;
    let skillId: string | undefined;
    for (let revision = 0; revision < 20; revision++) {
      const pkg = await store.publish(actor, {
        name,
        scope: "project",
        projectId: project.id,
        skillId,
        baseRevision: base,
        files: {
          "SKILL.md": Buffer.from(
            `---\nname: ${name}\ndescription: Continuation ${revision}.\n---\nBody ${revision}.\n`,
          ),
        },
      });
      skillId = pkg.skill_id;
      base = pkg.revision;
    }
    const revisionsDir = await revisionsDirOf(
      storage,
      root,
      actor.tenantId,
      skillId!,
    );
    const liveNames = (await readdir(revisionsDir)).filter((entry) =>
      /^[a-f0-9]{64}$/.test(entry),
    );
    expect(liveNames.length).toBeGreaterThanOrEqual(20);
    const orphan = nameAbove(liveNames);
    const orphanDir = join(revisionsDir, orphan, name);
    await mkdir(orphanDir, { recursive: true, mode: 0o700 });
    await writeFile(join(orphanDir, "SKILL.md"), "orphan");
    await utimes(join(revisionsDir, orphan), stale, stale);
    await utimes(orphanDir, stale, stale);
    let rounds = 0;
    let complete = false;
    let reclaimed = 0;
    let referenced = 0;
    while (!complete && rounds < 12) {
      const result = await store.reclaim(actor);
      rounds++;
      complete = result.reclaim_complete;
      reclaimed += result.reclaimed_revisions;
      referenced += result.skipped.referenced;
    }
    // İlk turda yalnız budget kadar canlı kayıt incelenir; orphan sonraki turlarda bulunur.
    expect(rounds).toBeGreaterThanOrEqual(3);
    expect(complete).toBe(true);
    expect(reclaimed).toBe(1);
    expect(referenced).toBeGreaterThanOrEqual(20);
    expect(
      await lstat(orphanDir).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await storage.db
        .selectFrom("skill_revisions")
        .select("revision")
        .where("tenant_id", "=", actor.tenantId)
        .where("skill_id", "=", skillId!)
        .execute(),
    ).toHaveLength(20);
    for (const live of liveNames)
      expect(
        await lstat(join(revisionsDir, live)).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
    const state = await storage.db
      .selectFrom("package_scan_state")
      .select("scan_cursor")
      .where("tenant_id", "=", actor.tenantId)
      .executeTakeFirst();
    expect(state?.scan_cursor ?? "").toBe("");
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #28 an active reclaim claim blocks publisher re-ownership; the committed winner is never deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gc-claim-"));
  const { storage, actor, project, store } = await fixture(root, {
    reclaimBudget: 50,
    reclaimGraceMs: 30,
    claimWaitMs: 200,
    leaseMs: 60_000,
  });
  try {
    const name = `claim-race-${randomUUID().slice(0, 8)}`;
    const files = {
      "SKILL.md": Buffer.from(
        `---\nname: ${name}\ndescription: Claim race.\n---\nBody.\n`,
      ),
    };
    const pkg = await store.publish(actor, {
      name,
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files,
    });
    const dir = await revisionsDirOf(
      storage,
      root,
      actor.tenantId,
      pkg.skill_id,
    );
    const orphanDir = join(dir, pkg.revision);
    // Crash sonrası orphan: DB satırı yok, dizin duruyor.
    await storage.db
      .updateTable("skills")
      .set({ active_revision: null })
      .where("tenant_id", "=", actor.tenantId)
      .where("id", "=", pkg.skill_id)
      .execute();
    await storage.db
      .deleteFrom("skill_revisions")
      .where("tenant_id", "=", actor.tenantId)
      .where("skill_id", "=", pkg.skill_id)
      .execute();
    await utimes(orphanDir, stale, stale);
    const dbNow = await storage.now();
    await storage.db
      .insertInto("package_claims")
      .values({
        tenant_id: actor.tenantId,
        kind: "revision",
        claim_key: `${pkg.skill_id}/${pkg.revision}`,
        owner: "paused-gc",
        expires_at: dbNow + 5_000,
        created_at: dbNow,
      })
      .execute();
    // Aktif claim varken yayın destination'ı sahiplenemez.
    await expect(
      store.publish(actor, {
        name,
        scope: "project",
        projectId: project.id,
        skillId: pkg.skill_id,
        baseRevision: null,
        files,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(
      await storage.db
        .selectFrom("skill_revisions")
        .select("revision")
        .where("tenant_id", "=", actor.tenantId)
        .where("skill_id", "=", pkg.skill_id)
        .execute(),
    ).toEqual([]);
    expect(
      await lstat(join(orphanDir, name)).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    // GC claim'i bıraktıktan sonra aynı destination'a yayın başarılı olur.
    await storage.db
      .deleteFrom("package_claims")
      .where("tenant_id", "=", actor.tenantId)
      .where("claim_key", "=", `${pkg.skill_id}/${pkg.revision}`)
      .execute();
    const republished = await store.publish(actor, {
      name,
      scope: "project",
      projectId: project.id,
      skillId: pkg.skill_id,
      baseRevision: null,
      files,
    });
    expect(republished.revision).toBe(pkg.revision);
    expect(
      await storage.db
        .selectFrom("package_claims")
        .select("claim_key")
        .where("tenant_id", "=", actor.tenantId)
        .execute(),
    ).toEqual([]);
    // Kazanan revision referanslıdır: reclaim dokunamaz.
    const protectedRun = await store.reclaim(actor);
    expect(protectedRun.reclaimed_revisions).toBe(0);
    expect(protectedRun.skipped.referenced).toBeGreaterThanOrEqual(1);
    expect(
      await lstat(join(orphanDir, name)).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    await expect(
      store.files(actor, pkg.skill_id, pkg.revision, ["SKILL.md"]),
    ).resolves.toBeDefined();
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #28 reclaim defers to a live publisher claim and only removes the orphan after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gc-publisher-"));
  const { storage, actor, project, store } = await fixture(root, {
    reclaimBudget: 50,
    reclaimGraceMs: 30,
    leaseMs: 60_000,
  });
  try {
    const name = `publisher-${randomUUID().slice(0, 8)}`;
    const pkg = await store.publish(actor, {
      name,
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: {
        "SKILL.md": Buffer.from(
          `---\nname: ${name}\ndescription: Publisher claim.\n---\nBody.\n`,
        ),
      },
    });
    const dir = await revisionsDirOf(
      storage,
      root,
      actor.tenantId,
      pkg.skill_id,
    );
    const orphan = "e".repeat(64);
    const orphanDir = join(dir, orphan, name);
    await mkdir(orphanDir, { recursive: true, mode: 0o700 });
    await writeFile(join(orphanDir, "SKILL.md"), "orphan");
    await utimes(join(dir, orphan), stale, stale);
    await utimes(orphanDir, stale, stale);
    const dbNow = await storage.now();
    await storage.db
      .insertInto("package_claims")
      .values({
        tenant_id: actor.tenantId,
        kind: "revision",
        claim_key: `${pkg.skill_id}/${orphan}`,
        owner: "publisher-x",
        expires_at: dbNow + 60_000,
        created_at: dbNow,
      })
      .execute();
    const waiting = await store.reclaim(actor);
    expect(waiting.reclaimed_revisions).toBe(0);
    expect(waiting.skipped.claims).toBeGreaterThanOrEqual(1);
    expect(
      await lstat(orphanDir).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    await storage.db
      .deleteFrom("package_claims")
      .where("tenant_id", "=", actor.tenantId)
      .where("kind", "=", "revision")
      .where("claim_key", "=", `${pkg.skill_id}/${orphan}`)
      .execute();
    const released = await store.reclaim(actor);
    expect(released.reclaimed_revisions).toBe(1);
    expect(
      await lstat(join(dir, orphan)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #28 active reader and ownerless backup pins keep their revision directory during reclaim", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gc-pins-"));
  const { storage, actor, project, store } = await fixture(root, {
    reclaimBudget: 50,
    reclaimGraceMs: 30,
    leaseMs: 400,
  });
  try {
    const name = `pins-${randomUUID().slice(0, 8)}`;
    const pkg = await store.publish(actor, {
      name,
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: {
        "SKILL.md": Buffer.from(
          `---\nname: ${name}\ndescription: Reader and backup pin protection.\n---\nBody.\n`,
        ),
      },
    });
    const dir = await revisionsDirOf(
      storage,
      root,
      actor.tenantId,
      pkg.skill_id,
    );
    // Referanslı dizin eski görünse bile pinler silinmesini engeller.
    await utimes(join(dir, pkg.revision), stale, stale);
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reading = store.withRevision(
      actor,
      pkg.skill_id,
      pkg.revision,
      async () => {
        holding.resolve();
        await release.promise;
        return "pinned";
      },
    );
    await holding.promise;
    await storage.db
      .insertInto("revision_readers")
      .values({
        tenant_id: actor.tenantId,
        id: randomUUID(),
        skill_id: pkg.skill_id,
        revision: pkg.revision,
        created_at: await storage.now(),
        kind: "backup",
        owner: null,
        expires_at: null,
      })
      .execute();
    const claimed = await store.reclaim(actor);
    expect(claimed.reclaimed_revisions).toBe(0);
    expect(claimed.skipped.referenced).toBeGreaterThanOrEqual(1);
    expect(await exists(join(dir, pkg.revision, name))).toBe(true);
    expect(
      await storage.db
        .selectFrom("revision_readers")
        .select("id")
        .where("tenant_id", "=", actor.tenantId)
        .where("owner", "is", null)
        .executeTakeFirst(),
    ).toBeDefined();
    release.resolve();
    await expect(reading).resolves.toBe("pinned");
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #28 filesystem removal failure is reported with diagnostics and retried successfully", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gc-failure-"));
  const { storage, actor, project, store } = await fixture(root, {
    reclaimBudget: 50,
    reclaimGraceMs: 30,
    leaseMs: 60_000,
  });
  try {
    const name = `failure-${randomUUID().slice(0, 8)}`;
    const pkg = await store.publish(actor, {
      name,
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: {
        "SKILL.md": Buffer.from(
          `---\nname: ${name}\ndescription: Removal failure diagnostics.\n---\nBody.\n`,
        ),
      },
    });
    const dir = await revisionsDirOf(
      storage,
      root,
      actor.tenantId,
      pkg.skill_id,
    );
    const orphan = "d".repeat(64);
    const orphanDir = join(dir, orphan, name);
    await mkdir(orphanDir, { recursive: true, mode: 0o700 });
    await writeFile(join(orphanDir, "SKILL.md"), "orphan");
    await utimes(join(dir, orphan), stale, stale);
    await utimes(orphanDir, stale, stale);
    await chmod(join(dir, orphan), 0o500);
    const failed = await store.reclaim(actor);
    expect(failed.reclaimed_revisions).toBe(0);
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(failed.errors[0]!.path).toBe(`${pkg.skill_id}/revisions/${orphan}`);
    // Hata sonrası claim bırakılır: tekrar deneme kilitli kalmaz.
    expect(
      await storage.db
        .selectFrom("package_claims")
        .select("claim_key")
        .where("tenant_id", "=", actor.tenantId)
        .execute(),
    ).toEqual([]);
    await chmod(join(dir, orphan), 0o700);
    const retried = await store.reclaim(actor);
    expect(retried.reclaimed_revisions).toBe(1);
    expect(retried.failed).toBe(0);
    expect(
      await lstat(join(dir, orphan)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #28 symlinked entries and intermediate dirs stay untouched; other tenants' trees stay untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gc-symlink-"));
  const { storage, actor, project, store } = await fixture(root, {
    reclaimBudget: 50,
    reclaimGraceMs: 30,
    leaseMs: 60_000,
  });
  try {
    const name = `symlink-${randomUUID().slice(0, 8)}`;
    const pkg = await store.publish(actor, {
      name,
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: {
        "SKILL.md": Buffer.from(
          `---\nname: ${name}\ndescription: Symlink confinement.\n---\nBody.\n`,
        ),
      },
    });
    const dir = await revisionsDirOf(
      storage,
      root,
      actor.tenantId,
      pkg.skill_id,
    );
    const outside = join(root, "outside-symlink");
    await mkdir(outside, { recursive: true, mode: 0o700 });
    await writeFile(join(outside, "sentinel.txt"), "sentinel");
    const linked = join(dir, "a".repeat(64));
    await symlink(outside, linked);
    await utimes(linked, stale, stale);
    // Ara dizin symlink'i: revisions -> dışarısı.
    const scopeDir = dirname(dirname(dir));
    const foreignSkill = join(scopeDir, "foreign-skill");
    await mkdir(foreignSkill, { recursive: true, mode: 0o700 });
    const foreign = join(root, "outside-intermediate");
    await mkdir(join(foreign, "b".repeat(64)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(foreign, "sentinel.txt"), "sentinel");
    await symlink(foreign, join(foreignSkill, "revisions"));
    // Başka tenant ağacındaki orphan'a dokunulmaz.
    const otherTenant = join(
      root,
      "tenants",
      tenantHash("another-tenant"),
      "packages",
      "a".repeat(20),
      "other-skill",
      "revisions",
      "c".repeat(64),
      "other",
    );
    await mkdir(otherTenant, { recursive: true, mode: 0o700 });
    await writeFile(join(otherTenant, "SKILL.md"), "other");
    await utimes(join(otherTenant, "..", ".."), stale, stale);
    const result = await store.reclaim(actor);
    expect(result.reclaimed_revisions).toBe(0);
    expect(result.skipped.symlinks).toBeGreaterThanOrEqual(1);
    expect(
      await lstat(linked).then(
        (info) => info.isSymbolicLink(),
        () => false,
      ),
    ).toBe(true);
    expect(
      await lstat(join(outside, "sentinel.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(
      await lstat(join(foreign, "sentinel.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(
      await lstat(join(foreign, "b".repeat(64))).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(
      await lstat(join(otherTenant, "SKILL.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("P2 #28 GET integrity report deletes nothing; POST reclaim mutates with admin ACL and audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gc-http-"));
  const config = await localConfig(root);
  const storage = await openDatabase({ dataDir: root });
  let server: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  try {
    const actor = await new IdentityService(storage.db).bootstrapLocal();
    const project = await new IdentityService(storage.db).createProject(
      actor,
      "Integrity HTTP",
    );
    const store = new PackageStore(storage, root);
    const name = `http-${randomUUID().slice(0, 8)}`;
    const pkg = await store.publish(actor, {
      name,
      scope: "project",
      projectId: project.id,
      baseRevision: null,
      files: {
        "SKILL.md": Buffer.from(
          `---\nname: ${name}\ndescription: GET vs POST integrity.\n---\nBody.\n`,
        ),
      },
    });
    const dir = await revisionsDirOf(
      storage,
      root,
      actor.tenantId,
      pkg.skill_id,
    );
    server = await createHttpServer(config);
    const headers = {
      host: new URL(config.url).host,
      authorization: `Bearer ${config.token}`,
    };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const health = (await server.inject({ url: "/health", headers })).json();
      if (health.package_integrity.status !== "checking") break;
      await sleep(10);
    }
    // Startup bittikten sonra orphan'lar oluşturulur.
    const orphan = "b".repeat(64);
    const orphanDir = join(dir, orphan, name);
    await mkdir(orphanDir, { recursive: true, mode: 0o700 });
    await writeFile(join(orphanDir, "SKILL.md"), "orphan");
    await utimes(join(dir, orphan), stale, stale);
    await utimes(orphanDir, stale, stale);
    const stagingRoot = join(
      root,
      "tenants",
      tenantHash(actor.tenantId),
      "staging",
    );
    const stagingDir = join(stagingRoot, randomUUID());
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    await writeFile(join(stagingDir, "leftover"), "staging");
    await utimes(stagingDir, stale, stale);
    // Salt GET raporu dosya silmez.
    const report = await server.inject({
      url: "/api/packages/integrity",
      headers,
    });
    expect(report.statusCode).toBe(200);
    expect(
      await lstat(join(dir, orphan)).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(
      await lstat(stagingDir).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    // Yetkisiz mutasyon reddedilir.
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/packages/integrity",
          headers: { host: headers.host },
        })
      ).statusCode,
    ).toBe(401);
    // Açık admin mutasyonu reclaim eder.
    const reclaim = await server.inject({
      method: "POST",
      url: "/api/packages/integrity",
      headers,
    });
    expect(reclaim.statusCode).toBe(200);
    const body = reclaim.json() as {
      reclaimed_revisions: number;
      reclaimed_staging: number;
    };
    expect(body.reclaimed_revisions).toBeGreaterThanOrEqual(1);
    expect(body.reclaimed_staging).toBeGreaterThanOrEqual(1);
    expect(
      await lstat(join(dir, orphan)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await lstat(stagingDir).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await server.close();
    server = undefined;
    const audit = await storage.db
      .selectFrom("audit_events")
      .select(["kind", "detail"])
      .where("tenant_id", "=", actor.tenantId)
      .where("kind", "=", "package.reclaim")
      .execute();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({
      reclaimed_revisions: expect.any(Number),
      reclaimed_staging: expect.any(Number),
    });
  } finally {
    if (server) await server.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
