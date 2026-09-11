/**
 * Bağımsız M01 (#34) kabul testleri — sözleşme odaklı.
 *
 * Bu dosya çekirdek ajanın testleriyle çakışmasın diye `-independent` sonekini
 * taşır ve M01 birleşmeden bu dalda derlenemez/koşamaz: hafıza modülleri
 * `memory/m08-verify` dalında henüz yok. Bu yüzden dosya yüzeyi çalışma anında
 * çözer:
 *
 * - M01 modülleri (MemoryService, `src/domain/memory.ts`, memory job kind'ları)
 *   bulunursa testler gerçek `JobQueue` + `ForgeWorker` + `openDatabase` ile
 *   koşar.
 * - Bulunmazsa bütün dosya gerekçesiyle atlanır ve konsola hangi yüzeylerin
 *   eksik olduğu yazılır.
 * - `MEMORY_REQUIRE_M01=1` iken eksik yüzey ölümcüldür: birleşme sonrası CI bu
 *   dosyayı bu değişkenle koşmalıdır ki sessiz atlama kabul sayılmasın.
 *
 * SÖZLEŞME VARSAYIMLARI (koordinatör kararı; birleşmede doğrulanacak):
 * 1. `JobQueue.accept(identity, {kind,key,payload,scope})`; `scope` =
 *    `{type:"project",projectId}` | `{type:"personal"}` | `{type:"organization"}`.
 *    Eski `projectId` alanı skill dışı işlerde de kabul edilir.
 * 2. `Run.project_id: string|null`, `Run.scope_kind`, `Run.scope_key`;
 *    proje kapsamında `scope_key === projectId`, diğerlerinde kararlı ve boş
 *    olmayan bir anahtar.
 * 3. `new MemoryService(storage)`; `ensureSpace(identity, scope)`;
 *    `authorizeSpace(identity, spaceId, "read"|"write")`;
 *    `recordEvent(identity, {spaceId,key,hash,payload})`;
 *    `reconcile(identity, spaceId)`.
 * 4. `recordEvent` aynı anahtar+hash'te idempotent, aynı anahtar farklı hash'te
 *    409 kodlu hata üretir. Yetkisiz uzay erişimi 403/404 reddiyle kapanır.
 * 5. `src/domain/memory.ts` parse/serialize/hash çifti; hash revision alanını
 *    dışarıda bırakır; gelecek format reddedilir; supersession döngüsü
 *    reddedilir; wikilink aynı başlıkta rastgele seçmez.
 * 6. Memory kind payload'ı en az `{content, hash, eventKey}` taşır; memory
 *    kind tanımları `skillProfile:false`. Alan adları entegrasyonda burada
 *    tek noktada güncellenir.
 *
 * Kanıt sözleşmesi ve inceleme adımları: `docs/tr/hafiza-kabul.md`.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  service: [
    "../src/application/memory.js",
    "../src/memory/service.js",
    "../src/memory/index.js",
    "../src/application/memory-service.js",
  ],
  kinds: ["../src/domain/job-kinds.js"],
} as const;

async function tryImport(paths: readonly string[]): Promise<{
  module: AnyModule | null;
  reasons: string[];
}> {
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

const [domainImport, serviceImport, kindsImport] = await Promise.all([
  tryImport(IMPORT_CANDIDATES.domain),
  tryImport(IMPORT_CANDIDATES.service),
  tryImport(IMPORT_CANDIDATES.kinds),
]);

const kindsModule = kindsImport.module;
const defaultKinds = (kindsModule?.defaultJobKinds ?? {}) as Record<
  string,
  unknown
>;
const memoryKinds = (kindsModule?.memoryJobKinds ?? {}) as Record<
  string,
  unknown
>;
const mergedKinds = { ...defaultKinds, ...memoryKinds };

const MemoryServiceClass =
  (serviceImport.module?.MemoryService as new (...args: never[]) => unknown) ??
  ((serviceImport.module?.default as AnyModule | undefined)?.MemoryService as
    (new (...args: never[]) => unknown) | undefined) ??
  (typeof serviceImport.module?.default === "function"
    ? (serviceImport.module.default as new (...args: never[]) => unknown)
    : undefined);

const domainSurface = {
  parse: firstFunction(domainImport.module, [
    "parseMemoryDocument",
    "parseNote",
    "parseMemoryNote",
    "parse",
  ]),
  serialize: firstFunction(domainImport.module, [
    "serializeMemoryDocument",
    "serializeMemoryNote",
    "serializeNote",
    "serialize",
  ]),
  hash: firstFunction(domainImport.module, [
    "memoryDocumentHash",
    "hashMemoryDocument",
    "memoryHash",
    "hashNote",
    "hash",
  ]),
  cycle: firstFunction(domainImport.module, [
    "assertNoSupersessionCycle",
    "assertAcyclicSupersessions",
    "validateSupersessions",
  ]),
  wikilink: firstFunction(domainImport.module, [
    "resolveWikilink",
    "resolveWikiLink",
  ]),
};

const missingReasons = [
  ...domainImport.reasons,
  ...serviceImport.reasons,
  ...kindsImport.reasons,
  ...(domainImport.module === null ? ["src/domain/memory.ts yok"] : []),
  ...(MemoryServiceClass === undefined
    ? ["MemoryService export edilmiyor"]
    : []),
  ...(!mergedKinds.memory_ingest || !mergedKinds.memory_reconcile
    ? ["memory_ingest / memory_reconcile job kind tanımı yok"]
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
    "[memory-acceptance-independent] M01 yüzeyi bu dalda yok; bağımsız kabul " +
      "testleri atlanıyor. Eksikler:\n- " +
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

async function openBackend(backend: BackendName): Promise<Backend> {
  const root = await mkdtemp(join(tmpdir(), `forge-mem-acc-${backend}-`));
  const storage = await openDatabase(
    backend === "postgres"
      ? { dataDir: root, postgresUrl: process.env.FORGE_TEST_POSTGRES_URL! }
      : { dataDir: root },
  );
  return {
    backend,
    storage,
    close: async () => {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
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

function memoryPayload(key: string, content = `içerik-${key}`) {
  return {
    eventKey: key,
    hash: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface MemoryServiceLike {
  ensureSpace(identity: Identity, scope: unknown): Promise<unknown>;
  authorizeSpace(
    identity: Identity,
    spaceId: string,
    permission: "read" | "write",
  ): Promise<unknown>;
  recordEvent(identity: Identity, event: unknown): Promise<unknown>;
  reconcile(identity: Identity, spaceId: string): Promise<unknown>;
}

function memoryService(storage: DatabaseHandle): MemoryServiceLike {
  return new MemoryServiceClass!(storage) as unknown as MemoryServiceLike;
}

function spaceIdOf(result: unknown): string {
  if (typeof result === "string" && result.length > 0) return result;
  const record = result as Record<string, unknown>;
  for (const key of ["id", "spaceId", "space_id", "memory_space_id"]) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(
    `ensureSpace dönüşünde uzay kimliği bulunamadı: ${JSON.stringify(result)}`,
  );
}

function receiptIdOf(result: unknown): string | null {
  if (typeof result === "string" && result.length > 0) return result;
  const record = result as Record<string, unknown>;
  for (const key of [
    "id",
    "receiptId",
    "receipt_id",
    "eventId",
    "event_id",
    "runId",
    "run_id",
  ]) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const receipt = record?.receipt as Record<string, unknown> | undefined;
  if (receipt)
    for (const key of ["id", "receiptId", "receipt_id"]) {
      const value = receipt[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  return null;
}

/** Reddi yakalar; programlama hatası (TypeError/ReferenceError) sayılmaz. */
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

function scopeForRun(run: { scope_kind: string; scope_key: string }): {
  type: string;
  projectId?: string;
} {
  return run.scope_kind === "project"
    ? { type: "project", projectId: run.scope_key }
    : { type: run.scope_kind };
}

async function waitForTerminal(
  queue: JobQueue,
  identity: Identity,
  runId: string,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await queue.get(identity, runId);
    if (terminalStates.includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} terminal duruma ulaşmadı`);
}

// ---------------------------------------------------------------------------
// Testler
// ---------------------------------------------------------------------------

if (!m01Available) {
  test.skip("M01 yüzeyi henüz birleşmedi; bağımsız kabul koşusu atlandı (MEMORY_REQUIRE_M01=1 ile sert kapı)", () => {});
}

describeM01("M01 bağımsız kabul", () => {
  test("yüzey çözümü: memory kind'ları skillProfile:false ve domain export'ları çözüldü", () => {
    for (const kind of ["memory_ingest", "memory_reconcile"]) {
      const definition = mergedKinds[kind] as { skillProfile?: boolean };
      expect(definition, kind).toBeDefined();
      expect(definition.skillProfile, kind).toBe(false);
    }
    expect(domainSurface.parse, "parse export").not.toBeNull();
    expect(domainSurface.serialize, "serialize export").not.toBeNull();
    expect(domainSurface.hash, "hash export").not.toBeNull();
  });

  for (const backend of [
    "sqlite",
    ...(process.env.FORGE_TEST_POSTGRES_URL ? (["postgres"] as const) : []),
  ] as BackendName[]) {
    describe(`backend: ${backend}`, () => {
      test("kişisel/proje/organizasyon kapsam matrisi: accept, Run alanları, kalıcılık", async () => {
        const { storage, close } = await openBackend(backend);
        try {
          const identities = new IdentityService(storage.db);
          const owner = await identities.bootstrapLocal();
          const project = await identities.createProject(
            owner,
            "Kabul projesi",
          );
          const queue = new JobQueue(
            storage,
            { evolutionEnabled: false },
            mergedKinds,
          );
          const scopes = [
            { type: "personal" as const },
            { type: "organization" as const },
            { type: "project" as const, projectId: project.id },
          ];
          for (const scope of scopes) {
            const key = `matris-${scope.type}`;
            const accepted = await queue.accept(owner, {
              kind: "memory_ingest",
              key,
              payload: memoryPayload(key),
              scope,
            });
            expect(accepted.status, scope.type).toBe("accepted");
            const run = accepted.run;
            expect(run.scope_kind, scope.type).toBe(scope.type);
            expect(typeof run.scope_key).toBe("string");
            expect(run.scope_key.length).toBeGreaterThan(0);
            if (scope.type === "project") {
              expect(run.project_id).toBe(project.id);
              expect(run.scope_key).toBe(project.id);
            } else {
              expect(run.project_id).toBeNull();
            }
            const persisted = await queue.get(owner, run.id);
            expect(persisted.scope_kind).toBe(scope.type);
            expect(persisted.scope_key).toBe(run.scope_key);
          }
        } finally {
          await close();
        }
      });

      test("idempotency: aynı anahtar aynı hash duplicate, farklı hash 409", async () => {
        const { storage, close } = await openBackend(backend);
        try {
          const owner = await new IdentityService(storage.db).bootstrapLocal();
          const queue = new JobQueue(
            storage,
            { evolutionEnabled: false },
            mergedKinds,
          );
          const key = "idem-1";
          const first = await queue.accept(owner, {
            kind: "memory_ingest",
            key,
            payload: memoryPayload(key, "sürüm-1"),
            scope: { type: "personal" },
          });
          const second = await queue.accept(owner, {
            kind: "memory_ingest",
            key,
            payload: memoryPayload(key, "sürüm-1"),
            scope: { type: "personal" },
          });
          expect(second.status).toBe("duplicate");
          expect(second.run.id).toBe(first.run.id);
          const rows = await storage.db
            .selectFrom("runs")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("tenant_id", "=", owner.tenantId)
            .where("idempotency_key", "=", key)
            .executeTakeFirstOrThrow();
          expect(Number(rows.n)).toBe(1);
          const conflict = await rejection(() =>
            queue.accept(owner, {
              kind: "memory_ingest",
              key,
              payload: memoryPayload(key, "sürüm-2"),
              scope: { type: "personal" },
            }),
          );
          expect(conflict.code).toBe("idempotency_conflict");
          expect(conflict.status).toBe(409);
        } finally {
          await close();
        }
      });

      test("evolution kapalı: hafıza işi geçer, skill işi eski kapıyı korur", async () => {
        const { storage, close } = await openBackend(backend);
        try {
          const identities = new IdentityService(storage.db);
          const owner = await identities.bootstrapLocal();
          const project = await identities.createProject(owner, "Kapı projesi");
          const queue = new JobQueue(
            storage,
            { evolutionEnabled: false },
            mergedKinds,
          );
          const memory = await queue.accept(owner, {
            kind: "memory_ingest",
            key: "evo-memory",
            payload: memoryPayload("evo-memory"),
            scope: { type: "organization" },
          });
          expect(memory.status).toBe("accepted");
          const skill = await rejection(() =>
            queue.accept(owner, {
              projectId: project.id,
              kind: "skill_evolve",
              key: "evo-skill",
              payload: {},
            }),
          );
          expect(skill.code).toBe("evolution_disabled");
          // Skill işi projesiz kabul edilmemeli; sahte proje oluşturulmamalı.
          const withoutProject = await rejection(() =>
            queue.accept(owner, {
              kind: "skill_evolve",
              key: "evo-skill-personal",
              payload: {},
              scope: { type: "personal" },
            }),
          );
          expect(typeof withoutProject.code === "string").toBe(true);
          const leaked = await storage.db
            .selectFrom("runs")
            .select("id")
            .where("idempotency_key", "in", ["evo-skill", "evo-skill-personal"])
            .execute();
          expect(leaked).toHaveLength(0);
          // Eski `projectId` alanı skill dışı hafıza işinde kapsam sayılır.
          const legacy = await queue.accept(owner, {
            projectId: project.id,
            kind: "memory_reconcile",
            key: "evo-legacy",
            payload: memoryPayload("evo-legacy"),
          });
          expect(legacy.status).toBe("accepted");
          expect(legacy.run.scope_kind).toBe("project");
          expect(legacy.run.project_id).toBe(project.id);
        } finally {
          await close();
        }
      });

      test("gerçek worker + memory handler zinciri: completed, audit ve idempotent receipt", async () => {
        const { storage, close } = await openBackend(backend);
        const queue = new JobQueue(
          storage,
          { evolutionEnabled: false },
          mergedKinds,
        );
        let worker: ForgeWorker | undefined;
        try {
          const identities = new IdentityService(storage.db);
          const owner = await identities.bootstrapLocal();
          const project = await identities.createProject(
            owner,
            "Worker projesi",
          );
          const service = memoryService(storage);
          const handler = async (run: {
            tenant_id: string;
            user_id: string;
            scope_kind: string;
            scope_key: string;
            project_id: string | null;
            kind: string;
            idempotency_key: string;
            input_hash: string;
            input_json: string;
          }) => {
            const identity: Identity = {
              tenantId: run.tenant_id,
              userId: run.user_id,
            };
            const scope = scopeForRun(run);
            const spaceId = spaceIdOf(
              await service.ensureSpace(identity, scope),
            );
            if (run.kind === "memory_reconcile")
              await service.reconcile(identity, spaceId);
            const receipt = await service.recordEvent(identity, {
              spaceId,
              key: run.idempotency_key,
              hash: run.input_hash,
              payload: JSON.parse(run.input_json) as unknown,
            });
            return {
              state: "completed" as const,
              result: {
                scope_kind: run.scope_kind,
                scope_key: run.scope_key,
                project_id: run.project_id,
                receipt: receiptIdOf(receipt),
              },
            };
          };
          worker = new ForgeWorker(
            queue,
            async () => {
              throw new Error("bu üretim skill handler'ı çalışmamalı");
            },
            {
              pollMs: 20,
              handlers: {
                memory_ingest: handler as never,
                memory_reconcile: handler as never,
              } as never,
            },
          );
          await worker.start();
          const scopes = [
            { type: "personal" as const },
            { type: "organization" as const },
            { type: "project" as const, projectId: project.id },
          ];
          const accepted: { run: { id: string } }[] = [];
          for (const scope of scopes) {
            const key = `worker-${scope.type}`;
            accepted.push(
              await queue.accept(owner, {
                kind:
                  scope.type === "project"
                    ? "memory_reconcile"
                    : "memory_ingest",
                key,
                payload: memoryPayload(key),
                scope,
              }),
            );
          }
          for (const item of accepted) {
            const run = await waitForTerminal(queue, owner, item.run.id);
            expect(run.state, item.run.id).toBe("completed");
            const result = JSON.parse(run.result_json ?? "{}") as {
              scope_kind?: string;
              receipt?: string | null;
            };
            expect(result.scope_kind).toBe(run.scope_kind);
            // Aynı run yeniden işlense bile tek alıcı: idempotent receipt.
            if (result.receipt) {
              const identity = { tenantId: run.tenant_id, userId: run.user_id };
              const scope = scopeForRun(run);
              const spaceId = spaceIdOf(
                await service.ensureSpace(identity, scope),
              );
              const replay = await service.recordEvent(identity, {
                spaceId,
                key: run.idempotency_key,
                hash: run.input_hash,
                payload: JSON.parse(run.input_json) as unknown,
              });
              expect(receiptIdOf(replay)).toBe(result.receipt);
            }
          }
          const audit = await storage.db
            .selectFrom("audit_events")
            .select(["kind"])
            .where("tenant_id", "=", owner.tenantId)
            .where("kind", "in", ["job.accepted", "job.finished"])
            .execute();
          expect(
            audit.filter((row) => row.kind === "job.accepted").length,
          ).toBeGreaterThanOrEqual(3);
          expect(
            audit.filter((row) => row.kind === "job.finished").length,
          ).toBeGreaterThanOrEqual(3);
        } finally {
          await worker?.stop();
          await close();
        }
      }, 30000);

      test("MemoryService: ensureSpace kararlılığı, authorizeSpace matrisi, recordEvent idempotency", async () => {
        const { storage, close } = await openBackend(backend);
        try {
          const identities = new IdentityService(storage.db);
          const owner = await identities.bootstrapLocal();
          const project = await identities.createProject(
            owner,
            "Servis projesi",
          );
          const other = await createTenant(
            storage,
            "tenant-other",
            "user-other",
          );
          const reader = await createTenant(
            storage,
            "local",
            "reader-1",
            "reader",
          );
          const service = memoryService(storage);

          const personal = spaceIdOf(
            await service.ensureSpace(owner, { type: "personal" }),
          );
          const personalAgain = spaceIdOf(
            await service.ensureSpace(owner, { type: "personal" }),
          );
          expect(personalAgain).toBe(personal);
          const projectSpace = spaceIdOf(
            await service.ensureSpace(owner, {
              type: "project",
              projectId: project.id,
            }),
          );
          const orgSpace = spaceIdOf(
            await service.ensureSpace(owner, { type: "organization" }),
          );
          expect(new Set([personal, projectSpace, orgSpace]).size).toBe(3);
          const readerPersonal = spaceIdOf(
            await service.ensureSpace(reader, { type: "personal" }),
          );
          expect(readerPersonal).not.toBe(personal);

          await expect(
            service.authorizeSpace(owner, personal, "read"),
          ).resolves.toBeDefined();
          await expect(
            service.authorizeSpace(owner, personal, "write"),
          ).resolves.toBeDefined();
          for (const [identity, space, permission] of [
            [other, personal, "read"],
            [other, personal, "write"],
            [other, orgSpace, "read"],
            [reader, projectSpace, "read"],
            [reader, projectSpace, "write"],
          ] as const) {
            const denied = await rejection(() =>
              service.authorizeSpace(identity, space, permission),
            );
            expect(
              denied.status === 403 || denied.status === 404 || !!denied.code,
              `beklenen ret: ${space}/${permission}`,
            ).toBe(true);
          }

          const eventKey = "event-1";
          const first = await service.recordEvent(owner, {
            spaceId: personal,
            key: eventKey,
            hash: sha256("içerik-a"),
            payload: { content: "içerik-a" },
          });
          const replay = await service.recordEvent(owner, {
            spaceId: personal,
            key: eventKey,
            hash: sha256("içerik-a"),
            payload: { content: "içerik-a" },
          });
          const firstId = receiptIdOf(first);
          expect(firstId).not.toBeNull();
          expect(receiptIdOf(replay)).toBe(firstId);
          const conflict = await rejection(() =>
            service.recordEvent(owner, {
              spaceId: personal,
              key: eventKey,
              hash: sha256("içerik-b"),
              payload: { content: "içerik-b" },
            }),
          );
          expect(conflict.status).toBe(409);
          const forged = await rejection(() =>
            service.recordEvent(other, {
              spaceId: personal,
              key: "event-forged",
              hash: sha256("x"),
              payload: { content: "x" },
            }),
          );
          expect(
            forged.status === 403 || forged.status === 404 || !!forged.code,
          ).toBe(true);
        } finally {
          await close();
        }
      });

      test("yetki sahteciliği ve tenant izolasyonu negatifleri", async () => {
        const { storage, close } = await openBackend(backend);
        try {
          const identities = new IdentityService(storage.db);
          const owner = await identities.bootstrapLocal();
          const other = await createTenant(storage, "tenant-b", "user-b");
          const queue = new JobQueue(
            storage,
            { evolutionEnabled: false },
            mergedKinds,
          );
          const key = "forged-1";
          const accepted = await queue.accept(owner, {
            kind: "memory_ingest",
            key,
            payload: {
              ...memoryPayload(key),
              tenantId: other.tenantId,
              userId: other.userId,
              role: "admin",
            },
            scope: { type: "personal" },
          });
          // Kimlik payload'dan gelmez: run sahibi gerçek aktördür.
          expect(accepted.run.tenant_id).toBe(owner.tenantId);
          expect(accepted.run.user_id).toBe(owner.userId);
          expect(accepted.run.scope_kind).toBe("personal");
          const crossTenant = await rejection(() =>
            queue.get(other, accepted.run.id),
          );
          expect(crossTenant.status).toBe(404);
          expect(crossTenant.code).toBe("run_unavailable");
        } finally {
          await close();
        }
      });
    });
  }

  describe("domain memory sözleşmesi (src/domain/memory.ts)", () => {
    const hasRoundTripSurface =
      !!domainSurface.parse &&
      !!domainSurface.serialize &&
      !!domainSurface.hash;
    test.if(hasRoundTripSurface)(
      "parse/serialize round-trip ve revision-dışı hash",
      () => {
        if (
          !domainSurface.parse ||
          !domainSurface.serialize ||
          !domainSurface.hash
        )
          return;
        const sample = {
          formatVersion: 1,
          noteId: "note-1",
          memorySpaceId: "space-1",
          kind: "decision",
          title: "Örnek karar",
          summary: "Kısa özet.",
          body: "Gövde metni.",
          lifecycle: "active",
          revision: 1,
          spaceRevision: 2,
        };
        const serialized = domainSurface.serialize.fn(sample as never);
        expect(typeof serialized).toBe("string");
        const parsed = domainSurface.parse.fn(serialized as never) as Record<
          string,
          unknown
        >;
        expect(parsed.noteId ?? parsed.note_id).toBe("note-1");
        const firstHash = domainSurface.hash.fn(parsed as never);
        const bumped = { ...parsed, revision: 2 };
        const secondHash = domainSurface.hash.fn(bumped as never);
        expect(secondHash).toBe(firstHash);
      },
    );

    test.if(!!domainSurface.parse)(
      "gelecek format sürümü mutasyonsuz reddedilir",
      () => {
        const future = [
          "---",
          "formatVersion: 999",
          "noteId: note-future",
          "memorySpaceId: space-1",
          "kind: decision",
          "title: Gelecek",
          "---",
          "Gövde.",
        ].join("\n");
        const thrown = (() => {
          try {
            domainSurface.parse!.fn(future as never);
            return null;
          } catch (error) {
            return error;
          }
        })();
        expect(thrown).not.toBeNull();
      },
    );

    test.if(!!domainSurface.cycle)(
      "supersession döngüsü reddedilir, geçerli zincir kabul edilir",
      () => {
        expect(() =>
          domainSurface.cycle!.fn([
            { noteId: "a", supersedes: ["b"] },
            { noteId: "b", supersedes: ["c"] },
            { noteId: "c", supersedes: ["a"] },
          ] as never),
        ).toThrow();
        expect(() =>
          domainSurface.cycle!.fn([
            { noteId: "a", supersedes: [] },
            { noteId: "b", supersedes: ["a"] },
          ] as never),
        ).not.toThrow();
      },
    );

    test.if(!!domainSurface.wikilink)(
      "wikilink belirsizliği rastgele çözülmez",
      () => {
        const unique = domainSurface.wikilink!.fn(
          "Benzersiz" as never,
          [{ noteId: "n1", title: "Benzersiz" }] as never,
        ) as Record<string, unknown>;
        const uniqueId =
          typeof unique === "string"
            ? unique
            : ((unique.noteId as string | undefined) ??
              (unique.note_id as string | undefined));
        expect(uniqueId).toBe("n1");
        const ambiguous = (() => {
          try {
            return domainSurface.wikilink!.fn(
              "Aynı Başlık" as never,
              [
                { noteId: "n1", title: "Aynı Başlık" },
                { noteId: "n2", title: "Aynı Başlık" },
              ] as never,
            ) as unknown;
          } catch (error) {
            return { thrown: error as Error };
          }
        })();
        if (ambiguous && typeof ambiguous === "object" && "thrown" in ambiguous)
          return;
        const record = ambiguous as Record<string, unknown>;
        const declaredAmbiguous =
          record.ambiguous === true ||
          record.status === "ambiguous" ||
          record.error === "ambiguous";
        expect(declaredAmbiguous).toBe(true);
      },
    );
  });
});
