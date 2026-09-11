/**
 * Bağımsız M01 (#34) kabul testleri — gerçek public sözleşmeye göre.
 *
 * Bu dosya çekirdek ajanın testleriyle çakışmasın diye `-independent` sonekini
 * taşır. M01 birleşmiştir; yüzey çalışma anında çözülür ve eksik yüzey
 * `MEMORY_REQUIRE_M01=1` iken ölümcüldür (birleşme sonrası CI kapısı).
 *
 * SÖZLEŞME EŞLEMESİ (bağlayıcı):
 * - `src/memory/service.ts`: `new MemoryService(db, identities?)`;
 *   `ensureSpace(identity, {type:"personal"|"project",projectId})`;
 *   organizasyon `createOrganizationSpace(identity, name)` ile açılır ve
 *   `ensureSpace({type:"organization"})` 422 `invalid_scope` verir.
 *   `authorizeSpace(identity, spaceId, "read"|"write")` alan satırını döndürür.
 *   `recordEvent(identity, {spaceId,sourceEventKey,sourceKind,contentHash,observedAt?})`
 *   → `{status:"recorded"|"duplicate", event}`; aynı anahtar+farklı hash 409.
 *   `reconcile(identity, {spaceId?,limit?})` → sınırlı sayaç raporu.
 * - `src/memory/job-kinds.ts`: `memoryJobKinds`, `productionJobKinds`;
 *   ingest payload'ı `{spaceId,sourceEventKey,sourceKind,contentHash,observedAt?}`
 *   (strict), reconcile payload'ı `{spaceId?,limit?}`; ikisi de
 *   `skillProfile:false`, `scope:"memory"`.
 * - `src/memory/worker.ts`: `memoryJobHandlers(service)` gerçek handler'lar.
 * - Queue: `accept(identity, {kind,key,payload,scope})` veya eski `projectId`;
 *   `Run.project_id: string|null`, `scope_kind`, `scope_key` (proje: projectId,
 *   personal: userId, organization: "organization"); memory işleri bağımsız
 *   `memoryEnabled` bayrağıyla kapılanır.
 * - `src/domain/memory.ts`: `parseMemoryDocument` (durum döndürür, fırlatmaz),
 *   `serializeMemoryDocument`, `memoryRecordHash` (revision hariç),
 *   `detectSupersessionCycle` (döngüyü döndürür), `resolveWikilink`
 *   (resolved/ambiguous/missing).
 *
 * Testler gerçek `JobQueue` + `ForgeWorker` + gerçek memory handler'ları ile
 * koşar. SQLite her zaman; PostgreSQL yalnız `FORGE_TEST_POSTGRES_URL` varsa
 * ve her koşum için ayrı geçici veritabanı açılır (paylaşılan DB düşürülmez).
 *
 * Kanıt sözleşmesi ve inceleme adımları: `docs/tr/hafiza-kabul.md`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { JobQueue, terminalStates } from "../src/jobs/queue.js";
import { ForgeWorker } from "../src/jobs/worker.js";

// ---------------------------------------------------------------------------
// M01 yüzey çözümleme
// ---------------------------------------------------------------------------

type AnyModule = Record<string, unknown>;

const IMPORT_CANDIDATES = {
  domain: ["../src/domain/memory.js"],
  service: ["../src/memory/service.js"],
  memoryKinds: ["../src/memory/job-kinds.js"],
  coreKinds: ["../src/domain/job-kinds.js"],
  memoryWorker: ["../src/memory/worker.js"],
} as const;

async function tryImport(
  paths: readonly string[],
): Promise<{ module: AnyModule | null; reasons: string[] }> {
  const reasons: string[] = [];
  for (const path of paths) {
    try {
      return { module: (await import(path)) as AnyModule, reasons };
    } catch (error) {
      const name = (error as { name?: string }).name;
      const message = error instanceof Error ? error.message : String(error);
      const missing =
        name === "ResolveMessage" ||
        /cannot find module|cannot resolve|module not found|err_module_not_found/i.test(
          message,
        );
      if (!missing) throw error;
      reasons.push(`${path}: ${message.split("\n")[0]}`);
    }
  }
  return { module: null, reasons };
}

function firstFunction(
  module: AnyModule | null,
  names: readonly string[],
): { name: string; fn: (...args: never[]) => unknown } | null {
  if (!module) return null;
  for (const name of names) {
    const candidate = module[name];
    if (typeof candidate === "function")
      return { name, fn: candidate as (...args: never[]) => unknown };
  }
  return null;
}

const [
  domainImport,
  serviceImport,
  memoryKindsImport,
  coreKindsImport,
  workerImport,
] = await Promise.all([
  tryImport(IMPORT_CANDIDATES.domain),
  tryImport(IMPORT_CANDIDATES.service),
  tryImport(IMPORT_CANDIDATES.memoryKinds),
  tryImport(IMPORT_CANDIDATES.coreKinds),
  tryImport(IMPORT_CANDIDATES.memoryWorker),
]);

const memoryJobKinds = (memoryKindsImport.module?.memoryJobKinds ??
  {}) as Record<string, unknown>;
const productionKinds = (memoryKindsImport.module?.productionJobKinds ??
  null) as Record<string, unknown> | null;
const coreDefaultKinds = (coreKindsImport.module?.defaultJobKinds ??
  {}) as Record<string, unknown>;
const mergedKinds =
  productionKinds && Object.keys(productionKinds).length > 0
    ? productionKinds
    : { ...coreDefaultKinds, ...memoryJobKinds };

const MemoryServiceClass =
  (serviceImport.module?.MemoryService as new (...args: never[]) => unknown) ??
  ((serviceImport.module?.default as AnyModule | undefined)?.MemoryService as
    (new (...args: never[]) => unknown) | undefined);

const memoryJobHandlersFactory =
  (workerImport.module?.memoryJobHandlers as
    ((service: unknown) => unknown) | undefined) ?? undefined;

const domainSurface = {
  parse: firstFunction(domainImport.module, [
    "parseMemoryDocument",
    "parseNote",
  ]),
  serialize: firstFunction(domainImport.module, [
    "serializeMemoryDocument",
    "serializeNote",
  ]),
  hash: firstFunction(domainImport.module, ["memoryRecordHash", "hashNote"]),
  cycle: firstFunction(domainImport.module, [
    "detectSupersessionCycle",
    "assertNoSupersessionCycle",
  ]),
  wikilink: firstFunction(domainImport.module, ["resolveWikilink"]),
};

const missingReasons: string[] = [
  ...(domainImport.module === null ? domainImport.reasons : []),
  ...(serviceImport.module === null ? serviceImport.reasons : []),
  ...(memoryKindsImport.module === null ? memoryKindsImport.reasons : []),
  ...(coreKindsImport.module === null ? coreKindsImport.reasons : []),
  ...(workerImport.module === null ? workerImport.reasons : []),
  ...(domainImport.module === null ? ["src/domain/memory.ts yok"] : []),
  ...(MemoryServiceClass === undefined
    ? ["MemoryService export edilmiyor"]
    : []),
  ...(memoryJobHandlersFactory === undefined
    ? ["memoryJobHandlers export edilmiyor"]
    : []),
  ...(!mergedKinds.memory_ingest || !mergedKinds.memory_reconcile
    ? ["memory_ingest / memory_reconcile job kind tanımı yok"]
    : []),
  ...(domainSurface.parse === null ||
  domainSurface.serialize === null ||
  domainSurface.hash === null
    ? ["domain parse/serialize/hash export'ları çözülemedi"]
    : []),
];

const m01Available = missingReasons.length === 0;
const m01Required = process.env.MEMORY_REQUIRE_M01 === "1";

if (!m01Available && m01Required)
  throw new Error(
    `MEMORY_REQUIRE_M01=1 ama M01 yüzeyi eksik:\n- ${missingReasons.join("\n- ")}`,
  );

if (!m01Available)
  console.warn(
    "[memory-acceptance-independent] M01 yüzeyi eksik; bağımsız kabul " +
      "testleri atlanıyor:\n- " +
      missingReasons.join("\n- "),
  );

const describeM01 = m01Available ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

type BackendName = "sqlite" | "postgres";

interface Backend {
  backend: BackendName;
  storage: DatabaseHandle;
  close(): Promise<void>;
}

async function openSqliteBackend(): Promise<Backend> {
  const root = await mkdtemp(join(tmpdir(), "forge-mem-acc-sqlite-"));
  const storage = await openDatabase({ dataDir: root });
  return {
    backend: "sqlite",
    storage,
    close: async () => {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Fresh scratch database per run; the shared verification DB is untouched. */
async function openPostgresBackend(): Promise<Backend> {
  const base = process.env.FORGE_TEST_POSTGRES_URL;
  if (!base) throw new Error("FORGE_TEST_POSTGRES_URL is not set");
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const name = `forge_mem_acc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.query(`create database "${name}"`);
  const databaseUrl = new URL(base);
  databaseUrl.pathname = `/${name}`;
  const root = await mkdtemp(join(tmpdir(), "forge-mem-acc-pg-"));
  try {
    const storage = await openDatabase({
      dataDir: root,
      postgresUrl: databaseUrl.toString(),
    });
    return {
      backend: "postgres",
      storage,
      close: async () => {
        await storage.close();
        await admin.query(`drop database if exists "${name}" with (force)`);
        await admin.end();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await admin.query(`drop database if exists "${name}"`).catch(() => {});
    await admin.end();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function openBackend(backend: BackendName): Promise<Backend> {
  return backend === "postgres" ? openPostgresBackend() : openSqliteBackend();
}

async function createTenant(
  storage: DatabaseHandle,
  tenantId: string,
  userId: string,
  role = "founder",
): Promise<Identity> {
  await storage.db
    .insertInto("users")
    .values({
      id: userId,
      subject: userId,
      display_name: userId,
      created_at: Date.now(),
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await storage.db
    .insertInto("tenants")
    .values({ id: tenantId, name: tenantId, created_at: Date.now() })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await storage.db
    .insertInto("memberships")
    .values({ tenant_id: tenantId, user_id: userId, role })
    .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
    .execute();
  return { tenantId, userId };
}

/** Unique actor per test, so repeated runs never collide on any backend. */
async function uniqueTenant(
  storage: DatabaseHandle,
  role = "founder",
): Promise<Identity> {
  const tag = randomUUID().replace(/-/g, "").slice(0, 12);
  return createTenant(storage, `tenant-${tag}`, `user-${tag}`, role);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ingestPayload(
  spaceId: string,
  key: string,
  content = `içerik-${key}`,
) {
  return {
    spaceId,
    sourceEventKey: key,
    sourceKind: "manual",
    contentHash: sha256(content),
  };
}

interface MemorySpaceRow {
  id: string;
  kind: string;
  tenant_id: string;
  owner_user_id: string;
  project_id: string | null;
  name: string;
}

interface MemoryEventRow {
  id: string;
  content_hash: string;
  space_id: string;
  source_event_key: string;
  state: string;
  observed_at: number | null;
}

interface ReconcileReportLike {
  checked: number;
  pending: number;
  committed: number;
  rejected: number;
  conflicts: number;
}

interface MemoryServiceLike {
  ensureSpace(identity: Identity, scope: unknown): Promise<MemorySpaceRow>;
  createOrganizationSpace(
    identity: Identity,
    name: string,
  ): Promise<MemorySpaceRow>;
  authorizeSpace(
    identity: Identity,
    spaceId: string,
    access: "read" | "write",
  ): Promise<MemorySpaceRow>;
  recordEvent(
    identity: Identity,
    input: {
      spaceId: string;
      sourceEventKey: string;
      sourceKind: string;
      contentHash: string;
      observedAt?: number;
    },
  ): Promise<{ status: "recorded" | "duplicate"; event: MemoryEventRow }>;
  reconcile(
    identity: Identity,
    input?: { spaceId?: string; limit?: number },
  ): Promise<ReconcileReportLike>;
}

function memoryService(storage: DatabaseHandle): MemoryServiceLike {
  return new MemoryServiceClass!(storage.db) as unknown as MemoryServiceLike;
}

async function rejection(
  action: () => Promise<unknown>,
): Promise<{ code?: string; status?: number; message?: string }> {
  try {
    await action();
  } catch (error) {
    if (error instanceof TypeError || error instanceof ReferenceError)
      throw error;
    return error as { code?: string; status?: number; message?: string };
  }
  throw new Error("yetki/kapsam reddi beklenirken çağrı başarılı oldu");
}

async function waitForTerminal(
  queue: JobQueue,
  identity: Identity,
  runId: string,
  timeoutMs = 20000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await queue.get(identity, runId);
    if (terminalStates.includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} terminal duruma ulaşmadı`);
}

function memoryPolicy() {
  // Memory is its own flag; evolution stays closed to prove independence.
  return { memoryEnabled: true, evolutionEnabled: false };
}

// ---------------------------------------------------------------------------
// Testler
// ---------------------------------------------------------------------------

if (!m01Available) {
  test.skip("M01 yüzeyi eksik; bağımsız kabul koşusu atlandı (MEMORY_REQUIRE_M01=1 ile sert kapı)", () => {});
}

describeM01("M01 bağımsız kabul", () => {
  test("yüzey: memory kind tanımları, handler fabrikası ve domain export'ları", () => {
    for (const kind of ["memory_ingest", "memory_reconcile"]) {
      const definition = mergedKinds[kind] as {
        skillProfile?: boolean;
        scope?: string;
      };
      expect(definition, kind).toBeDefined();
      expect(definition.skillProfile, kind).toBe(false);
      expect(definition.scope, kind).toBe("memory");
    }
    expect(typeof memoryJobHandlersFactory).toBe("function");
    expect(domainSurface.parse).not.toBeNull();
    expect(domainSurface.serialize).not.toBeNull();
    expect(domainSurface.hash).not.toBeNull();
    expect(domainSurface.cycle).not.toBeNull();
    expect(domainSurface.wikilink).not.toBeNull();
  });

  for (const backend of [
    "sqlite",
    ...(process.env.FORGE_TEST_POSTGRES_URL ? (["postgres"] as const) : []),
  ] as BackendName[]) {
    describe(`backend: ${backend}`, () => {
      let handle: Backend | undefined;
      beforeAll(async () => {
        handle = await openBackend(backend);
      }, 60000);
      afterAll(async () => {
        await handle?.close();
      }, 60000);
      const storage = () => handle!.storage;

      test("kapsam matrisi: accept, Run alanları, kapsam başına idempotency", async () => {
        const owner = await uniqueTenant(storage());
        const project = await new IdentityService(storage().db).createProject(
          owner,
          "Kabul projesi",
        );
        const service = memoryService(storage());
        const personal = await service.ensureSpace(owner, { type: "personal" });
        const organization = await service.createOrganizationSpace(
          owner,
          "Kabul organizasyon alanı",
        );
        const projectSpace = await service.ensureSpace(owner, {
          type: "project",
          projectId: project.id,
        });
        const queue = new JobQueue(storage(), memoryPolicy(), mergedKinds);
        const cases = [
          {
            scope: { type: "personal" as const },
            spaceId: personal.id,
            scopeKind: "personal",
            scopeKey: owner.userId,
            projectId: null,
          },
          {
            scope: { type: "organization" as const },
            spaceId: organization.id,
            scopeKind: "organization",
            scopeKey: "organization",
            projectId: null,
          },
          {
            scope: { type: "project" as const, projectId: project.id },
            spaceId: projectSpace.id,
            scopeKind: "project",
            scopeKey: project.id,
            projectId: project.id,
          },
        ];
        for (const testCase of cases) {
          const key = `matris-${testCase.scopeKind}`;
          const accepted = await queue.accept(owner, {
            kind: "memory_ingest",
            key,
            payload: ingestPayload(testCase.spaceId, key),
            scope: testCase.scope,
          });
          expect(accepted.status, testCase.scopeKind).toBe("accepted");
          const run = accepted.run;
          expect(run.scope_kind).toBe(testCase.scopeKind);
          expect(run.scope_key).toBe(testCase.scopeKey);
          expect(run.project_id).toBe(testCase.projectId);
          const persisted = await queue.get(owner, run.id);
          expect(persisted.scope_kind).toBe(testCase.scopeKind);
          expect(persisted.scope_key).toBe(testCase.scopeKey);
          await queue.cancel(owner, run.id);
        }
        // Aynı idempotency anahtarı farklı kapsamda yeni iş üretir
        // (tekillik scope_kind + scope_key + kind + key).
        const crossKey = "kapsamlar-arasi-anahtar";
        const personalRun = await queue.accept(owner, {
          kind: "memory_ingest",
          key: crossKey,
          payload: ingestPayload(personal.id, crossKey),
          scope: { type: "personal" },
        });
        const projectRun = await queue.accept(owner, {
          kind: "memory_ingest",
          key: crossKey,
          payload: ingestPayload(projectSpace.id, crossKey),
          scope: { type: "project", projectId: project.id },
        });
        expect(personalRun.status).toBe("accepted");
        expect(projectRun.status).toBe("accepted");
        expect(personalRun.run.id).not.toBe(projectRun.run.id);
        expect(personalRun.run.scope_key).toBe(owner.userId);
        expect(projectRun.run.scope_key).toBe(project.id);
        await queue.cancel(owner, personalRun.run.id);
        await queue.cancel(owner, projectRun.run.id);
      }, 30000);

      test("idempotency: aynı kapsam aynı hash duplicate, farklı hash 409", async () => {
        const owner = await uniqueTenant(storage());
        const service = memoryService(storage());
        const personal = await service.ensureSpace(owner, { type: "personal" });
        const queue = new JobQueue(storage(), memoryPolicy(), mergedKinds);
        const key = "idem-1";
        const first = await queue.accept(owner, {
          kind: "memory_ingest",
          key,
          payload: ingestPayload(personal.id, key, "sürüm-1"),
          scope: { type: "personal" },
        });
        const second = await queue.accept(owner, {
          kind: "memory_ingest",
          key,
          payload: ingestPayload(personal.id, key, "sürüm-1"),
          scope: { type: "personal" },
        });
        expect(second.status).toBe("duplicate");
        expect(second.run.id).toBe(first.run.id);
        const rows = await storage()
          .db.selectFrom("runs")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("tenant_id", "=", owner.tenantId)
          .where("scope_kind", "=", "personal")
          .where("scope_key", "=", owner.userId)
          .where("idempotency_key", "=", key)
          .executeTakeFirstOrThrow();
        expect(Number(rows.n)).toBe(1);
        const conflict = await rejection(() =>
          queue.accept(owner, {
            kind: "memory_ingest",
            key,
            payload: ingestPayload(personal.id, key, "sürüm-2"),
            scope: { type: "personal" },
          }),
        );
        expect(conflict.code).toBe("idempotency_conflict");
        expect(conflict.status).toBe(409);
        await queue.cancel(owner, first.run.id);
      }, 30000);

      test("bayraklar: evolution kapalı hafıza geçer, memory kapalı ve skill kapıları korunur", async () => {
        const owner = await uniqueTenant(storage());
        const project = await new IdentityService(storage().db).createProject(
          owner,
          "Bayrak projesi",
        );
        const service = memoryService(storage());
        const personal = await service.ensureSpace(owner, { type: "personal" });
        const memoryQueue = new JobQueue(
          storage(),
          memoryPolicy(),
          mergedKinds,
        );
        const accepted = await memoryQueue.accept(owner, {
          kind: "memory_ingest",
          key: "bayrak-memory",
          payload: ingestPayload(personal.id, "bayrak-memory"),
          scope: { type: "personal" },
        });
        expect(accepted.status).toBe("accepted");
        await memoryQueue.cancel(owner, accepted.run.id);

        const memoryOff = new JobQueue(
          storage(),
          { memoryEnabled: false, evolutionEnabled: true },
          mergedKinds,
        );
        const disabled = await rejection(() =>
          memoryOff.accept(owner, {
            kind: "memory_ingest",
            key: "bayrak-memory-off",
            payload: ingestPayload(personal.id, "bayrak-memory-off"),
            scope: { type: "personal" },
          }),
        );
        expect(disabled.code).toBe("memory_disabled");
        expect(disabled.status).toBe(422);

        const skill = await rejection(() =>
          memoryQueue.accept(owner, {
            projectId: project.id,
            kind: "skill_evolve",
            key: "bayrak-skill",
            payload: {},
          }),
        );
        expect(skill.code).toBe("evolution_disabled");
        const skillPersonal = await rejection(() =>
          memoryQueue.accept(owner, {
            kind: "skill_evolve",
            key: "bayrak-skill-personal",
            payload: {},
            scope: { type: "personal" },
          }),
        );
        expect(skillPersonal.code).toBe("invalid_scope");
        // Explicit proje kapsamı eski `projectId` ile aynı davranışı verir.
        const skillQueue = new JobQueue(
          storage(),
          { memoryEnabled: true, evolutionEnabled: true },
          mergedKinds,
        );
        const skillAccepted = await skillQueue.accept(owner, {
          scope: { type: "project", projectId: project.id },
          kind: "skill_evolve",
          key: "bayrak-skill-explicit",
          payload: {},
        });
        expect(skillAccepted.status).toBe("accepted");
        expect(skillAccepted.run.scope_kind).toBe("project");
        expect(skillAccepted.run.scope_key).toBe(project.id);
        expect(skillAccepted.run.project_id).toBe(project.id);
        await skillQueue.cancel(owner, skillAccepted.run.id);
        const bothScopes = await rejection(() =>
          memoryQueue.accept(owner, {
            projectId: project.id,
            scope: { type: "project", projectId: project.id },
            kind: "memory_ingest",
            key: "bayrak-both",
            payload: ingestPayload(personal.id, "bayrak-both"),
          }),
        );
        expect(bothScopes.code).toBe("invalid_scope");
        const leaked = await storage()
          .db.selectFrom("runs")
          .select("id")
          .where("idempotency_key", "in", [
            "bayrak-skill",
            "bayrak-skill-personal",
            "bayrak-both",
          ])
          .execute();
        expect(leaked).toHaveLength(0);

        // Eski projectId alanı memory kind için proje kapsamı sayılır.
        const legacy = await memoryQueue.accept(owner, {
          projectId: project.id,
          kind: "memory_reconcile",
          key: "bayrak-legacy",
          payload: { spaceId: personal.id },
        });
        expect(legacy.status).toBe("accepted");
        expect(legacy.run.scope_kind).toBe("project");
        expect(legacy.run.scope_key).toBe(project.id);
        expect(legacy.run.project_id).toBe(project.id);
        await memoryQueue.cancel(owner, legacy.run.id);
      }, 30000);

      test("lease fencing ve cancel memory kapsamında", async () => {
        const owner = await uniqueTenant(storage());
        const service = memoryService(storage());
        const personal = await service.ensureSpace(owner, { type: "personal" });
        const queue = new JobQueue(storage(), memoryPolicy(), mergedKinds);
        const accepted = await queue.accept(owner, {
          kind: "memory_ingest",
          key: "fence-1",
          payload: ingestPayload(personal.id, "fence-1"),
          scope: { type: "personal" },
        });
        const first = await queue.claim("old-worker", 30, "memory_ingest", {
          tenantId: owner.tenantId,
          runId: accepted.run.id,
        });
        expect(first).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 45));
        const second = await queue.claim("new-worker", 10000, "memory_ingest", {
          tenantId: owner.tenantId,
          runId: accepted.run.id,
        });
        expect(second).not.toBeNull();
        expect(second!.fence).toBe(2);
        const stale = await rejection(() =>
          queue.finish(first!, "completed", { should: "not-commit" }),
        );
        expect(stale.code).toBe("stale_worker");
        expect(stale.status).toBe(409);
        await queue.finish(second!, "no_op", { reason: "fence-test" });
        expect((await queue.get(owner, accepted.run.id)).state).toBe("no_op");

        const cancellable = await queue.accept(owner, {
          kind: "memory_ingest",
          key: "fence-cancel",
          payload: ingestPayload(personal.id, "fence-cancel"),
          scope: { type: "personal" },
        });
        await queue.cancel(owner, cancellable.run.id);
        const cancelled = await queue.get(owner, cancellable.run.id);
        expect(cancelled.state).toBe("cancelled");
        const audit = await storage()
          .db.selectFrom("audit_events")
          .select("kind")
          .where("tenant_id", "=", owner.tenantId)
          .where("kind", "=", "job.cancelled")
          .execute();
        expect(audit.length).toBeGreaterThanOrEqual(1);
      }, 30000);

      test("gerçek worker + gerçek memory handler zinciri: completed, audit, idempotent event, yabancı uzay reddi", async () => {
        const owner = await uniqueTenant(storage());
        const project = await new IdentityService(storage().db).createProject(
          owner,
          "Worker projesi",
        );
        const service = memoryService(storage());
        const personal = await service.ensureSpace(owner, { type: "personal" });
        const organization = await service.createOrganizationSpace(
          owner,
          "Worker organizasyon alanı",
        );
        const projectSpace = await service.ensureSpace(owner, {
          type: "project",
          projectId: project.id,
        });
        const queue = new JobQueue(storage(), memoryPolicy(), mergedKinds);
        const handlers = memoryJobHandlersFactory!(service) as Record<
          string,
          unknown
        >;
        // Proje alanında uzlaştırılacak gerçek bir olay olsun.
        await service.recordEvent(
          owner,
          ingestPayload(
            projectSpace.id,
            "worker-project-event",
            "içerik-proje",
          ),
        );
        let worker: ForgeWorker | undefined;
        try {
          worker = new ForgeWorker(
            queue,
            async () => {
              throw new Error("skill handler'ı bu koşuda çalışmamalı");
            },
            {
              pollMs: 20,
              handlers: handlers as never,
            },
          );
          await worker.start();
          const personalKey = "worker-personal";
          const orgKey = "worker-org";
          const accepted = [
            await queue.accept(owner, {
              kind: "memory_ingest",
              key: personalKey,
              payload: ingestPayload(
                personal.id,
                personalKey,
                "içerik-personal",
              ),
              scope: { type: "personal" },
            }),
            await queue.accept(owner, {
              kind: "memory_ingest",
              key: orgKey,
              payload: ingestPayload(organization.id, orgKey, "içerik-org"),
              scope: { type: "organization" },
            }),
            await queue.accept(owner, {
              kind: "memory_reconcile",
              key: "worker-project",
              payload: { spaceId: projectSpace.id },
              scope: { type: "project", projectId: project.id },
            }),
          ];
          const completedRuns = [];
          for (const item of accepted) {
            const run = await waitForTerminal(queue, owner, item.run.id);
            expect(run.state, item.run.id).toBe("completed");
            completedRuns.push(run);
          }
          const personalRun = completedRuns[0]!;
          const personalResult = JSON.parse(
            personalRun.result_json ?? "{}",
          ) as {
            status?: string;
            eventId?: string;
          };
          expect(personalResult.status).toBe("recorded");
          expect(typeof personalResult.eventId).toBe("string");
          expect(personalResult.eventId!.length).toBeGreaterThan(0);
          const reconcileResult = JSON.parse(
            completedRuns[2]!.result_json ?? "{}",
          ) as Partial<ReconcileReportLike>;
          expect(reconcileResult.checked).toBeGreaterThanOrEqual(1);
          expect(typeof reconcileResult.conflicts).toBe("number");

          // Aynı kaynak olay yeniden kaydedilirse duplicate ve aynı event id.
          const replay = await service.recordEvent(
            owner,
            ingestPayload(personal.id, personalKey, "içerik-personal"),
          );
          expect(replay.status).toBe("duplicate");
          expect(replay.event.id).toBe(personalResult.eventId);

          const audit = await storage()
            .db.selectFrom("audit_events")
            .select("kind")
            .where("tenant_id", "=", owner.tenantId)
            .where("kind", "in", ["job.accepted", "job.finished"])
            .execute();
          expect(
            audit.filter((row) => row.kind === "job.accepted").length,
          ).toBeGreaterThanOrEqual(3);
          expect(
            audit.filter((row) => row.kind === "job.finished").length,
          ).toBeGreaterThanOrEqual(3);

          // Yabancı tenant'ın uzayına yazma denemesi handler'da reddedilir.
          const foreign = await uniqueTenant(storage());
          const foreignSpace = await memoryService(storage()).ensureSpace(
            foreign,
            { type: "personal" },
          );
          const forged = await queue.accept(owner, {
            kind: "memory_ingest",
            key: "worker-forged-space",
            payload: ingestPayload(foreignSpace.id, "worker-forged-space"),
            scope: { type: "personal" },
          });
          const forgedRun = await waitForTerminal(queue, owner, forged.run.id);
          expect(forgedRun.state).toBe("failed");
          expect(forgedRun.error_code).toBe("memory_space_unavailable");
        } finally {
          await worker?.stop();
        }
      }, 60000);

      test("MemoryService ACL matrisi, ensureSpace/recordEvent/reconcile sözleşmesi", async () => {
        const owner = await uniqueTenant(storage());
        const project = await new IdentityService(storage().db).createProject(
          owner,
          "ACL projesi",
        );
        const readerTag = randomUUID().replace(/-/g, "").slice(0, 12);
        const reader = await createTenant(
          storage(),
          owner.tenantId,
          `reader-${readerTag}`,
          "reader",
        );
        const writerTag = randomUUID().replace(/-/g, "").slice(0, 12);
        const writer = await createTenant(
          storage(),
          owner.tenantId,
          `writer-${writerTag}`,
          "writer",
        );
        const other = await uniqueTenant(storage());
        const service = memoryService(storage());

        const personal = await service.ensureSpace(owner, { type: "personal" });
        const personalAgain = await service.ensureSpace(owner, {
          type: "personal",
        });
        expect(personalAgain.id).toBe(personal.id);
        const projectSpace = await service.ensureSpace(owner, {
          type: "project",
          projectId: project.id,
        });
        const organization = await service.createOrganizationSpace(
          owner,
          "ACL organizasyon alanı",
        );
        expect(
          new Set([personal.id, projectSpace.id, organization.id]).size,
        ).toBe(3);
        const writerPersonal = await service.ensureSpace(writer, {
          type: "personal",
        });
        expect(writerPersonal.id).not.toBe(personal.id);
        const orgScope = await rejection(() =>
          service.ensureSpace(owner, { type: "organization" }),
        );
        expect(orgScope.code).toBe("invalid_scope");
        expect(orgScope.status).toBe(422);

        // Kişisel: yalnız sahibi; başka tenant 404, aynı tenant başka kullanıcı 403.
        const ownRead = await service.authorizeSpace(
          owner,
          personal.id,
          "read",
        );
        expect(ownRead.id).toBe(personal.id);
        expect(ownRead.kind).toBe("personal");
        await expect(
          service.authorizeSpace(owner, personal.id, "write"),
        ).resolves.toBeDefined();
        const foreignRead = await rejection(() =>
          service.authorizeSpace(other, personal.id, "read"),
        );
        expect(foreignRead.code).toBe("memory_space_unavailable");
        expect(foreignRead.status).toBe(404);
        const readerRead = await rejection(() =>
          service.authorizeSpace(reader, personal.id, "read"),
        );
        expect(readerRead.code).toBe("forbidden");
        expect(readerRead.status).toBe(403);

        // Organizasyon: tenant üyesi okur, salt okunur yazamaz.
        await expect(
          service.authorizeSpace(reader, organization.id, "read"),
        ).resolves.toBeDefined();
        const orgWrite = await rejection(() =>
          service.authorizeSpace(reader, organization.id, "write"),
        );
        expect(orgWrite.status).toBe(403);

        // Proje: üyelik yoksa reddedilir.
        const projectRead = await rejection(() =>
          service.authorizeSpace(reader, projectSpace.id, "read"),
        );
        expect(projectRead.status).toBe(403);
        const projectWrite = await rejection(() =>
          service.authorizeSpace(reader, projectSpace.id, "write"),
        );
        expect(projectWrite.status).toBe(403);

        // recordEvent sözleşmesi.
        const invalidHash = await rejection(() =>
          service.recordEvent(owner, {
            spaceId: personal.id,
            sourceEventKey: "acl-event",
            sourceKind: "manual",
            contentHash: "not-a-hash",
          }),
        );
        expect(invalidHash.code).toBe("invalid_memory_event");
        expect(invalidHash.status).toBe(422);
        const observedAt = Date.now() - 1000;
        const first = await service.recordEvent(owner, {
          ...ingestPayload(personal.id, "acl-event", "içerik-a"),
          observedAt,
        });
        expect(first.status).toBe("recorded");
        expect(first.event.observed_at).toBe(observedAt);
        const duplicate = await service.recordEvent(
          owner,
          ingestPayload(personal.id, "acl-event", "içerik-a"),
        );
        expect(duplicate.status).toBe("duplicate");
        expect(duplicate.event.id).toBe(first.event.id);
        const conflict = await rejection(() =>
          service.recordEvent(
            owner,
            ingestPayload(personal.id, "acl-event", "içerik-b"),
          ),
        );
        expect(conflict.code).toBe("memory_event_conflict");
        expect(conflict.status).toBe(409);
        const foreignWrite = await rejection(() =>
          service.recordEvent(
            other,
            ingestPayload(personal.id, "acl-foreign", "x"),
          ),
        );
        expect(foreignWrite.status).toBe(404);
        const readerWrite = await rejection(() =>
          service.recordEvent(
            reader,
            ingestPayload(personal.id, "acl-reader", "x"),
          ),
        );
        expect(readerWrite.status).toBe(403);
        const orgReaderWrite = await rejection(() =>
          service.recordEvent(
            reader,
            ingestPayload(organization.id, "acl-org-reader", "x"),
          ),
        );
        expect(orgReaderWrite.status).toBe(403);
        const orgOwnerWrite = await service.recordEvent(
          owner,
          ingestPayload(organization.id, "acl-org-owner", "x"),
        );
        expect(orgOwnerWrite.status).toBe("recorded");

        // reconcile: yetkili uzaylarla sınırlı, sayaçlar gerçek.
        const personalReport = await service.reconcile(owner, {
          spaceId: personal.id,
        });
        expect(personalReport.checked).toBeGreaterThanOrEqual(1);
        expect(personalReport.pending).toBeGreaterThanOrEqual(1);
        expect(personalReport.conflicts).toBe(0);
        const bounded = await service.reconcile(owner, {
          spaceId: personal.id,
          limit: 1,
        });
        expect(bounded.checked).toBe(1);
        const invalidLimit = await rejection(() =>
          service.reconcile(owner, { limit: 0 }),
        );
        expect(invalidLimit.status).toBe(422);
        const readerPersonalReport = await rejection(() =>
          service.reconcile(reader, { spaceId: personal.id }),
        );
        expect(readerPersonalReport.status).toBe(403);
        // Okuyucu, sahibinin kişisel olaylarını yetkisiz uzay taramasında
        // göremez; yalnız yetkili olduğu organizasyon alanını görür.
        const orgEventCount = await storage()
          .db.selectFrom("memory_events")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("space_id", "=", organization.id)
          .executeTakeFirstOrThrow();
        const readerScan = await service.reconcile(reader, {});
        expect(readerScan.checked).toBe(Number(orgEventCount.n));
        expect(readerScan.pending).toBe(Number(orgEventCount.n));
        const readerOrgReport = await service.reconcile(reader, {
          spaceId: organization.id,
        });
        expect(readerOrgReport.checked).toBeGreaterThanOrEqual(1);
      }, 60000);

      test("eşzamanlı ensureSpace/recordEvent/accept tek sonuç üretir", async () => {
        const owner = await uniqueTenant(storage());
        const project = await new IdentityService(storage().db).createProject(
          owner,
          "Yarış projesi",
        );
        const service = memoryService(storage());
        const personalResults = await Promise.all(
          Array.from({ length: 5 }, () =>
            service.ensureSpace(owner, { type: "personal" }),
          ),
        );
        expect(new Set(personalResults.map((row) => row.id)).size).toBe(1);
        const projectResults = await Promise.all(
          Array.from({ length: 5 }, () =>
            service.ensureSpace(owner, {
              type: "project",
              projectId: project.id,
            }),
          ),
        );
        expect(new Set(projectResults.map((row) => row.id)).size).toBe(1);
        const spaceId = personalResults[0]!.id;
        const eventInput = ingestPayload(spaceId, "race-event", "yarış");
        const eventResults = await Promise.all(
          Array.from({ length: 5 }, () =>
            service.recordEvent(owner, eventInput),
          ),
        );
        expect(new Set(eventResults.map((row) => row.event.id)).size).toBe(1);
        expect(
          eventResults.filter((row) => row.status === "recorded"),
        ).toHaveLength(1);
        expect(
          eventResults.filter((row) => row.status === "duplicate"),
        ).toHaveLength(4);
        const queue = new JobQueue(storage(), memoryPolicy(), mergedKinds);
        const key = "race-accept";
        const accepts = await Promise.all(
          Array.from({ length: 5 }, () =>
            queue.accept(owner, {
              kind: "memory_ingest",
              key,
              payload: ingestPayload(spaceId, key, "yarış"),
              scope: { type: "personal" },
            }),
          ),
        );
        expect(accepts.filter((row) => row.status === "accepted")).toHaveLength(
          1,
        );
        expect(new Set(accepts.map((row) => row.run.id)).size).toBe(1);
        const runCount = await storage()
          .db.selectFrom("runs")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("tenant_id", "=", owner.tenantId)
          .where("idempotency_key", "=", key)
          .executeTakeFirstOrThrow();
        expect(Number(runCount.n)).toBe(1);
        await queue.cancel(owner, accepts[0]!.run.id);
      }, 30000);

      test("yetki sahteciliği ve tenant izolasyonu negatifleri", async () => {
        const owner = await uniqueTenant(storage());
        const other = await uniqueTenant(storage());
        const otherProject = await new IdentityService(
          storage().db,
        ).createProject(other, "Yabancı proje");
        const service = memoryService(storage());
        const personal = await service.ensureSpace(owner, { type: "personal" });
        const queue = new JobQueue(storage(), memoryPolicy(), mergedKinds);

        // Strict payload ek kimlik alanlarını kabul etmez: sahtecilik kapıda düşer.
        const forgedFields = await rejection(() =>
          queue.accept(owner, {
            kind: "memory_ingest",
            key: "sahte-alanlar",
            payload: {
              ...ingestPayload(personal.id, "sahte-alanlar"),
              tenantId: other.tenantId,
              userId: other.userId,
              role: "admin",
            },
            scope: { type: "personal" },
          }),
        );
        expect(forgedFields.code).toBe("invalid_handoff");
        expect(forgedFields.status).toBe(422);

        // Başka tenant'ın projesi kapsam olarak kullanılamaz.
        const foreignProject = await rejection(() =>
          queue.accept(owner, {
            kind: "memory_ingest",
            key: "sahte-proje",
            payload: ingestPayload(personal.id, "sahte-proje"),
            scope: { type: "project", projectId: otherProject.id },
          }),
        );
        expect(foreignProject.code).toBe("project_unavailable");
        expect(foreignProject.status).toBe(404);

        // Kimlik payload'dan gelmez; run sahibi gerçek aktördür.
        const accepted = await queue.accept(owner, {
          kind: "memory_ingest",
          key: "sahip-kontrol",
          payload: ingestPayload(personal.id, "sahip-kontrol"),
          scope: { type: "personal" },
        });
        expect(accepted.run.tenant_id).toBe(owner.tenantId);
        expect(accepted.run.user_id).toBe(owner.userId);
        const crossTenant = await rejection(() =>
          queue.get(other, accepted.run.id),
        );
        expect(crossTenant.code).toBe("run_unavailable");
        expect(crossTenant.status).toBe(404);
        await queue.cancel(owner, accepted.run.id);
      }, 30000);
    });
  }

  describe("domain memory sözleşmesi (src/domain/memory.ts)", () => {
    const parseSource = [
      "---",
      "format_version: 1",
      "note_id: note-1",
      "memory_space_id: space-1",
      "kind: decision",
      "title: Örnek karar",
      "summary: Kısa özet.",
      "lifecycle: active",
      "pinned: false",
      "edges: []",
      "sources: []",
      "revision: 1",
      "custom_field: korunacak",
      "---",
      "Gövde metni.",
    ].join("\n");

    test.if(
      !!domainSurface.parse &&
        !!domainSurface.serialize &&
        !!domainSurface.hash,
    )(
      "parse/serialize round-trip, revision-dışı hash ve bilinmeyen frontmatter korunumu",
      () => {
        const parsed = domainSurface.parse!.fn(parseSource as never) as {
          status: string;
          record: Record<string, unknown>;
        };
        expect(parsed.status).toBe("ok");
        expect(parsed.record.noteId).toBe("note-1");
        expect(parsed.record.spaceId).toBe("space-1");
        expect(parsed.record.kind).toBe("decision");
        expect(
          (parsed.record.unknown as Record<string, unknown>).custom_field,
        ).toBe("korunacak");
        const serialized = domainSurface.serialize!.fn(
          parsed.record as never,
        ) as string;
        expect(serialized).toContain("custom_field");
        const reparsed = domainSurface.parse!.fn(serialized as never) as {
          status: string;
          record: Record<string, unknown>;
        };
        expect(reparsed.status).toBe("ok");
        const firstHash = domainSurface.hash!.fn(parsed.record as never);
        expect(domainSurface.hash!.fn(reparsed.record as never)).toBe(
          firstHash,
        );
        const bumped = { ...parsed.record, revision: 99 };
        expect(domainSurface.hash!.fn(bumped as never)).toBe(firstHash);
        const changedBody = { ...parsed.record, body: "Değişmiş gövde." };
        expect(domainSurface.hash!.fn(changedBody as never)).not.toBe(
          firstHash,
        );
      },
    );

    test.if(!!domainSurface.parse)(
      "gelecek format sürümü reddedilir ve girdi değiştirilmez",
      () => {
        const future = [
          "---",
          "format_version: 999",
          "note_id: note-future",
          "memory_space_id: space-1",
          "kind: decision",
          "title: Gelecek",
          "---",
          "Gövde.",
        ].join("\n");
        const result = domainSurface.parse!.fn(future as never) as {
          status: string;
          formatVersion?: number;
        };
        expect(result.status).toBe("unsupported_format");
        expect(result.formatVersion).toBe(999);
        expect(future).toContain("format_version: 999");
        const invalid = domainSurface.parse!.fn("frontmatter yok" as never) as {
          status: string;
        };
        expect(invalid.status).toBe("invalid");
      },
    );

    test.if(!!domainSurface.cycle)(
      "supersession döngüsü tespit edilir, geçerli zincir temiz",
      () => {
        const cycle = domainSurface.cycle!.fn([
          { noteId: "a", supersedes: ["b"] },
          { noteId: "b", supersedes: ["c"] },
          { noteId: "c", supersedes: ["a"] },
        ] as never) as string[] | null;
        expect(cycle).not.toBeNull();
        expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
        expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
        const acyclic = domainSurface.cycle!.fn([
          { noteId: "a", supersedes: [] },
          { noteId: "b", supersedes: ["a"] },
        ] as never);
        expect(acyclic).toBeNull();
      },
    );

    test.if(!!domainSurface.wikilink)(
      "wikilink çözümü resolved/ambiguous/missing durumlarını ayırır",
      () => {
        const resolved = domainSurface.wikilink!.fn(
          "Benzersiz" as never,
          [{ noteId: "n1", title: "Benzersiz" }] as never,
        ) as { status: string; noteId?: string };
        expect(resolved.status).toBe("resolved");
        expect(resolved.noteId).toBe("n1");
        const ambiguous = domainSurface.wikilink!.fn(
          "Aynı Başlık" as never,
          [
            { noteId: "n1", title: "Aynı Başlık" },
            { noteId: "n2", title: "Aynı Başlık" },
          ] as never,
        ) as { status: string; candidates?: string[] };
        expect(ambiguous.status).toBe("ambiguous");
        expect(new Set(ambiguous.candidates)).toEqual(new Set(["n1", "n2"]));
        const missing = domainSurface.wikilink!.fn(
          "Yok" as never,
          [{ noteId: "n1", title: "Başka" }] as never,
        ) as { status: string };
        expect(missing.status).toBe("missing");
      },
    );
  });
});
