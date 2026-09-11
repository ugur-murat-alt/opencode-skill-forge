/**
 * Bağımsız M07 (#40) AGZ aktarım kabul testleri — gerçek fixture, SQLite hedef.
 *
 * Çekirdeğin `test/agz-import-pipeline.test.ts` senaryolarını kopyalamaz;
 * #40 kabul maddelerini kendi kurulumlarıyla doğrular: derin hedef
 * karşılaştırması (hash/referans/altı edge/eski-yeni hash ayrımı), tekrar
 * import, iki aşamalı kesinti + devam, rollback + yeniden plan, kaynak
 * değişmezliği, stage bütünlüğü, negatif fixture, Unicode/twin remap,
 * yetkisiz hedef matrisi, desteklenmeyen şema ve envanter cursor'ı.
 *
 * PostgreSQL koşulmaz: çekirdek M07 testleri de yalnız SQLite hedef kullanır;
 * M07 hattı M02 commit servisinin SQLite/PostgreSQL yolunu zaten M02’de
 * doğrulanmış kabul eder. Canlı AGZ verisine ve `agz-memory` reposuna
 * dokunulmaz; tek kaynak üretilen fixture'dır.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { sha256Hex } from "../src/memory/files.js";
import { noteWorkingPath, vaultRoot } from "../src/memory/paths.js";
import { MemoryService } from "../src/memory/service.js";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { openAgzSource, type AgzSource } from "../src/memory/agz/inventory.js";
import {
  agzDocumentRelativePath,
  deterministicAgzNoteId,
  ensureAgzTargetSpace,
  parseAgzManifestJson,
  verifyAgzManifest,
  type AgzProjectMapping,
} from "../src/memory/agz/manifest.js";
import {
  applyAgzImport,
  rollbackAgzImport,
  stageAgzImport,
} from "../src/memory/agz/pipeline.js";
import { compareAgzShadow } from "../src/memory/agz/shadow.js";
import {
  AGZ_FIXTURE_IDS,
  buildAgzFixture,
  buildUnsupportedSchemaFixture,
  fileSnapshot,
} from "./fixtures/agz/buildAgzFixture.js";

const FIXED_NOW = 1_775_000_000_000;
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Env {
  root: string;
  storage: DatabaseHandle;
  db: DatabaseHandle["db"];
  vault: string;
  identities: IdentityService;
  owner: Identity;
  service: MemoryService;
  commits: MemoryCommitService;
}

async function freshDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function openEnv(): Promise<Env> {
  const root = await freshDir("forge-m07-ind-");
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const vault = vaultRoot(root);
  const service = new MemoryService(storage.db, identities, vault);
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: vault,
    service,
  });
  return {
    root,
    storage,
    db: storage.db,
    vault,
    identities,
    owner,
    service,
    commits,
  };
}

async function bindMappings(
  env: Env,
  options: { alphaKind?: "personal" | "organization" } = {},
): Promise<AgzProjectMapping[]> {
  const alphaKind = options.alphaKind ?? "personal";
  return [
    await ensureAgzTargetSpace({
      service: env.service,
      identity: env.owner,
      sourceProjectId: AGZ_FIXTURE_IDS.projectAlpha,
      sourceName: "Proje Alfa",
      normalizedName: "proje alfa",
      kind: alphaKind,
      organizationName: "AGZ Alfa",
    }),
    await ensureAgzTargetSpace({
      service: env.service,
      identity: env.owner,
      sourceProjectId: AGZ_FIXTURE_IDS.projectBeta,
      sourceName: "Proje Beta",
      normalizedName: "proje beta",
      kind: "organization",
      organizationName: "AGZ Beta",
    }),
    await ensureAgzTargetSpace({
      service: env.service,
      identity: env.owner,
      sourceProjectId: AGZ_FIXTURE_IDS.projectArchive,
      sourceName: "Arşiv",
      normalizedName: "arsiv",
      kind: "organization",
      organizationName: "AGZ Arşiv",
    }),
  ];
}

async function sourceOf(path: string): Promise<AgzSource> {
  return openAgzSource(path, { now: () => FIXED_NOW });
}

async function planOf(
  env: Env,
  source: AgzSource,
  mappings: readonly AgzProjectMapping[],
) {
  const { planAgzImport } = await import("../src/memory/agz/manifest.js");
  return planAgzImport({
    source,
    targetDb: env.db,
    mappings,
    now: () => FIXED_NOW,
  });
}

async function countRows(env: Env, table: string): Promise<number> {
  const row = await env.db
    .selectFrom(table as never)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function humanEdit(
  env: Env,
  spaceId: string,
  noteId: string,
  newBody: string,
): Promise<{ revision: number }> {
  const current = await env.service.readNote(env.owner, { spaceId, noteId });
  if (!current.content || current.note.current_revision === null)
    throw new Error("düzenlenecek kabul edilmiş içerik yok");
  const marker = current.content.indexOf("\n---\n");
  const updated = `${current.content.slice(0, marker + 5)}${newBody}\n`;
  const outcome = await env.service.recordEvent(env.owner, {
    spaceId,
    sourceEventKey: `human-${randomUUID()}`,
    sourceKind: "manual",
    contentHash: sha256Hex(updated),
  });
  const receipt = await env.commits.commit({
    identity: env.owner,
    spaceId,
    eventId: outcome.event.id,
    sourceKind: "manual",
    content: updated,
    noteId,
    baseRevision: current.note.current_revision,
  });
  return { revision: receipt.revision };
}

/** Kaynak dizininin dosya adı+hash parmak izi (WAL/SHM dahil). */
async function directoryFingerprint(
  dir: string,
): Promise<Record<string, string>> {
  const entries = await readdir(dir);
  const result: Record<string, string> = {};
  for (const name of entries.sort()) {
    const path = join(dir, name);
    const stat = await readdir(path)
      .then(() => "dir")
      .catch(() => "file");
    if (stat === "file") result[name] = (await fileSnapshot(path)).sha256;
  }
  return result;
}

async function listVaultFiles(vault: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(vault, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listVaultFiles(vault, rel)));
    else out.push(rel);
  }
  return out;
}

async function rejection(
  action: () => Promise<unknown>,
): Promise<{ code?: string; status?: number }> {
  try {
    await action();
  } catch (error) {
    if (error instanceof TypeError || error instanceof ReferenceError)
      throw error;
    return error as { code?: string; status?: number };
  }
  throw new Error("red beklenirken çağrı başarılı oldu");
}

describe("M07 bağımsız kabul", () => {
  let cleanDir: string;
  let cleanPath: string;
  let negativeDir: string;
  let negativePath: string;
  let twinDir: string;
  let twinPath: string;

  beforeAll(async () => {
    cleanDir = await freshDir("forge-m07-clean-");
    cleanPath = join(cleanDir, "agz.db");
    await buildAgzFixture(cleanPath, { profile: "clean" });
    negativeDir = await freshDir("forge-m07-neg-");
    negativePath = join(negativeDir, "agz.db");
    await buildAgzFixture(negativePath, { profile: "negative" });
    twinDir = await freshDir("forge-m07-twin-");
    twinPath = join(twinDir, "agz.db");
    await buildAgzFixture(twinPath, { profile: "clean", variant: "twin" });
  }, 60000);

  test("1) clean apply: hedef sayı/hash/referans, altı edge, eski AGZ hash'i hedef hash değil", async () => {
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(cleanPath);
      try {
        const plan = await planOf(env, source, mappings);
        expect(plan.manifest.decision.status).toBe("ready");
        expect(plan.manifest.counts).toMatchObject({
          notes: 8,
          readyNotes: 8,
          revisions: 11,
          edges: 6,
          pinned: 2,
        });
        // Eski AGZ hash'leri yalnız kaynak izi; hedef hash'i M01 ile hesaplanır.
        for (const note of plan.manifest.notes)
          for (const revision of note.revisions)
            expect(revision.documentSha256).not.toBe(
              revision.sourceContentHash,
            );
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        const report = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: cleanPath,
        });
        expect(report.status).toBe("applied");
        expect(report.counters.notes).toMatchObject({
          planned: 8,
          applied: 8,
          failed: 0,
          conflict: 0,
        });
        expect(await countRows(env, "memory_notes")).toBe(8);
        expect(await countRows(env, "memory_note_revisions")).toBe(11);
        expect(await countRows(env, "memory_events")).toBe(11);

        const { parseMemoryDocument } = await import("../src/domain/memory.js");
        const spaceOf = new Map(
          mappings.map((mapping) => [
            mapping.sourceProjectId,
            mapping.target.memorySpaceId,
          ]),
        );
        let edgeRelations = new Set<string>();
        for (const note of plan.manifest.notes) {
          const spaceId = spaceOf.get(note.sourceProjectId)!;
          const row = await env.db
            .selectFrom("memory_notes")
            .selectAll()
            .where("space_id", "=", spaceId)
            .where("id", "=", note.targetNoteId)
            .executeTakeFirstOrThrow();
          expect(row.title).toBe(note.title);
          expect(row.lifecycle).toBe(note.lifecycle);
          expect(Boolean(row.pinned)).toBe(note.pinned);
          expect(row.current_revision).toBe(
            note.revisions.at(-1)!.targetRevision,
          );
          for (const revision of note.revisions) {
            const revisionRow = await env.db
              .selectFrom("memory_note_revisions")
              .selectAll()
              .where("space_id", "=", spaceId)
              .where("note_id", "=", note.targetNoteId)
              .where("revision", "=", revision.targetRevision)
              .executeTakeFirstOrThrow();
            const content = await readFile(
              join(env.vault, revisionRow.file_path!),
              "utf8",
            );
            expect(sha256Hex(content)).toBe(revisionRow.content_hash);
            const metadata = JSON.parse(revisionRow.metadata_json) as {
              client_hash?: string;
            };
            expect(metadata.client_hash).toBe(revision.documentSha256);
            // Eski AGZ hash'i hedef content_hash gibi yazılmaz; yalnız
            // frontmatter `sources[].hash` ve `agz_content_hash` alanında iz.
            expect(revisionRow.content_hash).not.toBe(
              revision.sourceContentHash,
            );
            expect(content).toContain(revision.sourceContentHash);
            const parsed = parseMemoryDocument(content);
            expect(parsed.status).toBe("ok");
            if (parsed.status !== "ok") continue;
            expect(parsed.record.noteId).toBe(note.targetNoteId);
            expect(parsed.record.spaceId).toBe(spaceId);
            expect(parsed.record.sources.length).toBeGreaterThanOrEqual(1);
            expect(parsed.record.unknown.agz_content_hash).toBe(
              revision.sourceContentHash,
            );
            if (revision === note.revisions.at(-1)) {
              // Ara revizyonlar farklı tür/yaşam döngüsü taşıyabilir
              // (fixture tarih revizyonlarını context olarak modelliyor);
              // head revizyonu manifesttekiyle birebir olmalı.
              expect(parsed.record.kind).toBe(note.kind);
              expect(parsed.record.lifecycle).toBe(note.lifecycle);
              for (const edge of parsed.record.edges)
                edgeRelations.add(edge.relation);
              expect(new Set(parsed.record.edges.map((e) => e.target))).toEqual(
                new Set(note.edges.map((edge) => edge.targetNoteId)),
              );
            }
          }
        }
        // Altı AGZ edge türü de hedefe taşındı.
        expect(edgeRelations).toEqual(
          new Set([
            "SUPPORTS",
            "DERIVED_FROM",
            "PART_OF",
            "ABOUT",
            "PRECEDES",
            "SUPERSEDES",
          ]),
        );
        const shadow = await compareAgzShadow({
          service: env.service,
          identity: env.owner,
          vaultRoot: env.vault,
          manifest: plan.manifest,
        });
        expect(shadow.decision).toBe("match");
        expect(shadow.coverage.revisions).toBe(1);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  }, 60000);

  test("2) tekrar import: already_applied, yeni satır yok, receipt aynı hedefleri gösterir", async () => {
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(cleanPath);
      try {
        const plan = await planOf(env, source, mappings);
        const first = await stageAgzImport(plan, { vaultRoot: env.vault });
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: first.stageDir,
          sourcePath: cleanPath,
        });
        const before = [
          await countRows(env, "memory_notes"),
          await countRows(env, "memory_note_revisions"),
          await countRows(env, "memory_events"),
        ];
        const second = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: first.stageDir,
          sourcePath: cleanPath,
        });
        expect(second.status).toBe("already_applied");
        expect(second.counters.notes.duplicate).toBe(8);
        expect(second.counters.revisions.duplicate).toBe(11);
        expect([
          await countRows(env, "memory_notes"),
          await countRows(env, "memory_note_revisions"),
          await countRows(env, "memory_events"),
        ]).toEqual(before);
        const receipt = JSON.parse(
          await readFile(join(first.stageDir, "receipt.json"), "utf8"),
        ) as {
          items: { sourceNoteId: string; targetNoteId: string }[];
          counters: { notes: { duplicate: number } };
        };
        const bySource = new Map(
          plan.manifest.notes.map((note) => [
            note.sourceNoteId,
            note.targetNoteId,
          ]),
        );
        for (const item of receipt.items)
          expect(item.targetNoteId).toBe(bySource.get(item.sourceNoteId));
        expect(receipt.counters.notes.duplicate).toBe(8);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  }, 60000);

  test("3) iki aşamalı kesinti + devamlar: çoğaltma yok, receipt tamamlanır", async () => {
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(cleanPath);
      try {
        const plan = await planOf(env, source, mappings);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        let crashes = [1, 4];
        const hooks = {
          afterItem: (index: number) => {
            if (crashes.includes(index)) {
              crashes = crashes.filter((value) => value !== index);
              throw new Error(`simüle kesinti @${index}`);
            }
          },
        };
        await rejection(() =>
          applyAgzImport({
            service: env.service,
            commits: env.commits,
            identity: env.owner,
            stageDir: staged.stageDir,
            sourcePath: cleanPath,
            hooks,
          }),
        );
        const afterFirst = await countRows(env, "memory_notes");
        expect(afterFirst).toBeGreaterThan(0);
        expect(afterFirst).toBeLessThan(8);
        await rejection(() =>
          applyAgzImport({
            service: env.service,
            commits: env.commits,
            identity: env.owner,
            stageDir: staged.stageDir,
            sourcePath: cleanPath,
            hooks,
          }),
        );
        const resumed = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: cleanPath,
        });
        expect(resumed.status).toBe("applied");
        expect(await countRows(env, "memory_notes")).toBe(8);
        expect(await countRows(env, "memory_note_revisions")).toBe(11);
        expect(await countRows(env, "memory_events")).toBe(11);
        // Aynı idempotency anahtarı ikinci olay üretmedi.
        const keys = await env.db
          .selectFrom("memory_events")
          .select(["source_event_key"])
          .execute();
        expect(new Set(keys.map((row) => row.source_event_key)).size).toBe(11);
        const again = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: cleanPath,
        });
        expect(again.status).toBe("already_applied");
        const receipt = JSON.parse(
          await readFile(join(staged.stageDir, "receipt.json"), "utf8"),
        ) as { counters: { notes: { applied: number; duplicate: number } } };
        expect(
          receipt.counters.notes.applied + receipt.counters.notes.duplicate,
        ).toBe(8);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  }, 90000);

  test("4) rollback: değişmemişler arşiv, insan düzenlemesi conflict, ikinci rollback idempotent, yeniden plan tombstone görür", async () => {
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(cleanPath);
      try {
        const plan = await planOf(env, source, mappings);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: cleanPath,
        });
        const alphaSpace = mappings[0]!.target.memorySpaceId;
        const edited = await humanEdit(
          env,
          alphaSpace,
          AGZ_FIXTURE_IDS.noteRule,
          "İnsan düzenlemesi korunmalı.\n",
        );
        const sourceBefore = await directoryFingerprint(cleanDir);
        const rolled = await rollbackAgzImport({
          service: env.service,
          identity: env.owner,
          stageDir: staged.stageDir,
        });
        expect(rolled.status).toBe("partial");
        expect(rolled.counters.rolledBack).toBeGreaterThan(0);
        expect(rolled.counters.conflict).toBe(1);
        expect(
          rolled.items.find(
            (item) => item.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
          )?.status,
        ).toBe("conflict");
        const editedRow = await env.db
          .selectFrom("memory_notes")
          .selectAll()
          .where("space_id", "=", alphaSpace)
          .where("id", "=", AGZ_FIXTURE_IDS.noteRule)
          .executeTakeFirstOrThrow();
        expect(editedRow.deleted_at).toBeNull();
        expect(editedRow.current_revision).toBe(edited.revision);
        // Revision dosyaları silinmez.
        const editedWorking = await readFile(
          noteWorkingPath(env.vault, alphaSpace, AGZ_FIXTURE_IDS.noteRule),
          "utf8",
        );
        expect(editedWorking).toContain("İnsan düzenlemesi korunmalı.");
        const archivedOther = await env.db
          .selectFrom("memory_notes")
          .selectAll()
          .where("id", "=", AGZ_FIXTURE_IDS.notePreference)
          .executeTakeFirstOrThrow();
        expect(archivedOther.deleted_at).not.toBeNull();
        // İkinci rollback: yalnız zaten geri alınmışlar + tek çatışma.
        const second = await rollbackAgzImport({
          service: env.service,
          identity: env.owner,
          stageDir: staged.stageDir,
        });
        expect(second.counters.rolledBack).toBe(0);
        expect(second.counters.alreadyRolledBack).toBe(7);
        expect(second.counters.conflict).toBe(1);
        expect(second.status).toBe("partial");
        // Kaynak değişmedi.
        expect(await directoryFingerprint(cleanDir)).toEqual(sourceBefore);
        // Eski stage replay'i tombstone'lu notları diriltmez; insan
        // düzenlemesi zaten committed olay olarak duplicate kalır.
        const beforeNotes = await countRows(env, "memory_notes");
        const replay = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: cleanPath,
        });
        expect(await countRows(env, "memory_notes")).toBe(beforeNotes);
        // Güvenlik özelliği: hiçbir tombstone dirilmez. (Replay'in durum
        // etiketi ayrı `test.failing` ile sorgulanır.)
        expect(replay.items.some((item) => item.status === "quarantined")).toBe(
          false,
        );
        const stillDeleted = await env.db
          .selectFrom("memory_notes")
          .select(["deleted_at"])
          .where("id", "=", AGZ_FIXTURE_IDS.notePreference)
          .executeTakeFirstOrThrow();
        expect(stillDeleted.deleted_at).not.toBeNull();
        // Yeniden plan: tombstone'lu hedefler blocking görünür; aynı kaynak
        // snapshot'ında stage dizini paylaşıldığı için eski receipt farklı
        // manifest digest'ine bağlıdır ve yeni plan sessizce uygulanmaz.
        const replan = await planOf(env, source, mappings);
        const deletedNote = replan.manifest.notes.find(
          (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.notePreference,
        )!;
        expect(deletedNote.status).toBe("quarantined");
        expect(
          deletedNote.issues.some(
            (issue) => issue.code === "target_note_deleted",
          ),
        ).toBe(true);
        await stageAgzImport(replan, { vaultRoot: env.vault });
        const digestConflict = await rejection(() =>
          applyAgzImport({
            service: env.service,
            commits: env.commits,
            identity: env.owner,
            stageDir: staged.stageDir,
            sourcePath: cleanPath,
          }),
        );
        expect(digestConflict.code).toBe("agz_stage_conflict");
        expect(await countRows(env, "memory_notes")).toBe(beforeNotes);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  }, 90000);

  test("5) kaynak snapshot/stage bütünlüğü: değişen kaynak ve bozuk stage yazımsız reddedilir", async () => {
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(cleanPath);
      try {
        const plan = await planOf(env, source, mappings);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        const before = await countRows(env, "memory_notes");
        // Başka baytlar taşıyan snapshot aynı yolla verilirse reddedilir.
        const changed = await rejection(() =>
          applyAgzImport({
            service: env.service,
            commits: env.commits,
            identity: env.owner,
            stageDir: staged.stageDir,
            sourcePath: negativePath,
          }),
        );
        expect(changed.code).toBe("source_changed_during_scan");
        // stage.json bozulursa digest kontrolü reddeder.
        const metaPath = join(staged.stageDir, "stage.json");
        const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
          stageDigest: string;
        };
        await writeFile(
          metaPath,
          JSON.stringify({ ...meta, stageDigest: "0".repeat(64) }),
        );
        const broken = await rejection(() =>
          applyAgzImport({
            service: env.service,
            commits: env.commits,
            identity: env.owner,
            stageDir: staged.stageDir,
            sourcePath: cleanPath,
          }),
        );
        expect(broken.code).toBe("agz_stage_integrity");
        expect(await countRows(env, "memory_notes")).toBe(before);
        // Bloklayıcı manifest stage edilemez.
        const partial = await planOf(env, source, mappings.slice(0, 1));
        expect(partial.manifest.decision.status).toBe("blocked");
        const blocked = await rejection(() =>
          stageAgzImport(partial, { vaultRoot: env.vault }),
        );
        expect(blocked.code).toBe("agz_manifest_blocked");
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  }, 60000);

  test("6) negatif fixture: karantina/partial, hedefte tutarlı sonuç, dışlanan tablolar nota dönüşmez", async () => {
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(negativePath);
      try {
        const plan = await planOf(env, source, mappings);
        expect(plan.manifest.decision.status).toBe("partial");
        const quarantined = plan.manifest.notes
          .filter((note) => note.status === "quarantined")
          .map((note) => note.sourceNoteId)
          .sort();
        expect(quarantined).toEqual(
          [
            AGZ_FIXTURE_IDS.noteCurrentProcedure,
            AGZ_FIXTURE_IDS.noteOrphan,
            AGZ_FIXTURE_IDS.noteArchivedGap,
          ].sort(),
        );
        expect(plan.manifest.counts.droppedEdges).toBe(4);
        const codes = new Set(
          plan.manifest.notes.flatMap((note) =>
            note.issues.map((issue) => issue.code),
          ),
        );
        expect(codes.has("revision_content_hash_mismatch")).toBe(true);
        expect(
          codes.has("revision_missing_provenance") ||
            codes.has("note_missing_revisions"),
        ).toBe(true);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        const report = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: negativePath,
        });
        expect(report.status).toBe("partial");
        expect(report.counters.notes.quarantined).toBe(3);
        expect(report.counters.notes.applied).toBe(7);
        const ids = (
          await env.db.selectFrom("memory_notes").select(["id"]).execute()
        ).map((row) => row.id);
        for (const sourceId of [
          AGZ_FIXTURE_IDS.noteOrphan,
          AGZ_FIXTURE_IDS.noteArchivedGap,
          AGZ_FIXTURE_IDS.noteCurrentProcedure,
        ]) {
          expect(ids).not.toContain(sourceId);
        }
        // Karantinadaki notlar için vault dosyası da yok.
        const vaultFiles = await listVaultFiles(env.vault);
        for (const sourceId of [
          AGZ_FIXTURE_IDS.noteOrphan,
          AGZ_FIXTURE_IDS.noteArchivedGap,
        ])
          expect(vaultFiles.some((file) => file.includes(sourceId))).toBe(
            false,
          );
        const shadow = await compareAgzShadow({
          service: env.service,
          identity: env.owner,
          vaultRoot: env.vault,
          manifest: plan.manifest,
        });
        expect(shadow.decision).toBe("match");
        expect(
          shadow.quarantined.map((entry) => entry.sourceNoteId).sort(),
        ).toEqual(quarantined);
        const excludedTables = shadow.excluded.map((entry) => entry.table);
        expect(excludedTables).toContain("capture_events");
        expect(excludedTables).toContain("index_outbox");
        expect(excludedTables).toContain("notes_fts");
        // Hedef not sayısı yalnız hazır notlar kadardır.
        expect(ids).toHaveLength(7);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  }, 60000);

  test("7) Unicode kayıpsız; aynı ad/farklı UUID ve twin DB deterministik remap", async () => {
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(cleanPath);
      const { parseMemoryDocument } = await import("../src/domain/memory.js");
      try {
        const plan = await planOf(env, source, mappings);
        const unicodeSource = source
          .scanNotes({ limit: 100 })
          .items.find((note) => note.id === AGZ_FIXTURE_IDS.noteUnicode)!;
        const unicodeDoc = plan.documents.find(
          (doc) => doc.sourceNoteId === AGZ_FIXTURE_IDS.noteUnicode,
        )!;
        expect(unicodeDoc.content).toContain("Ünicode Başlık 🧠 — ğüşiöçİı");
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: cleanPath,
        });
        const alphaSpace = mappings[0]!.target.memorySpaceId;
        const unicodeWorking = await readFile(
          noteWorkingPath(env.vault, alphaSpace, AGZ_FIXTURE_IDS.noteUnicode),
          "utf8",
        );
        const parsed = parseMemoryDocument(unicodeWorking);
        expect(parsed.status).toBe("ok");
        if (parsed.status === "ok") {
          // NFC/NFD normalizasyonu yok; başlık ve gövde kaynak metinle
          // yalnız LF kanonikleştirmesi kadar farklı olur.
          expect(parsed.record.title).toBe(unicodeSource.title);
          expect(parsed.record.body).toBe(
            unicodeSource.content.replace(/\r\n?/g, "\n"),
          );
        }
        // Aynı adlı iki kaynak not ayrı UUID/kimlik taşır.
        const rule = plan.manifest.notes.find(
          (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
        )!;
        const duplicateTitle = plan.manifest.notes.find(
          (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteDuplicateTitle,
        )!;
        expect(rule.targetNoteId).not.toBe(duplicateTitle.targetNoteId);
      } finally {
        await source.close();
      }
      // Twin DB: aynı not UUID'si farklı içerikle gelince deterministik remap.
      const twinMappings: AgzProjectMapping[] = [
        {
          ...mappings[0]!,
          sourceProjectId: AGZ_FIXTURE_IDS.projectAlphaTwin,
          sourceName: "Proje Alfa",
          normalizedName: "proje alfa",
        },
        mappings[1]!,
        mappings[2]!,
      ];
      const twinSource = await sourceOf(twinPath);
      try {
        const twinPlan = await planOf(env, twinSource, twinMappings);
        const twinRule = twinPlan.manifest.notes.find(
          (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
        )!;
        expect(twinRule.idDecision).toBe("remapped");
        expect(twinRule.targetNoteId).toBe(
          deterministicAgzNoteId(
            AGZ_FIXTURE_IDS.twinDatabaseId,
            AGZ_FIXTURE_IDS.projectAlphaTwin,
            AGZ_FIXTURE_IDS.noteRule,
          ),
        );
        const twinAgain = await planOf(env, twinSource, twinMappings);
        expect(
          twinAgain.manifest.notes.find(
            (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
          )!.targetNoteId,
        ).toBe(twinRule.targetNoteId);
        const twinStage = await stageAgzImport(twinPlan, {
          vaultRoot: env.vault,
        });
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: twinStage.stageDir,
          sourcePath: twinPath,
        });
        const alphaSpace = mappings[0]!.target.memorySpaceId;
        const rows = await env.db
          .selectFrom("memory_notes")
          .select(["id"])
          .where("space_id", "=", alphaSpace)
          .where("id", "in", [AGZ_FIXTURE_IDS.noteRule, twinRule.targetNoteId])
          .execute();
        expect(rows).toHaveLength(2);
        const hashes = await env.db
          .selectFrom("memory_note_revisions")
          .select(["content_hash"])
          .where("space_id", "=", alphaSpace)
          .where("note_id", "in", [
            AGZ_FIXTURE_IDS.noteRule,
            twinRule.targetNoteId,
          ])
          .execute();
        expect(new Set(hashes.map((row) => row.content_hash)).size).toBe(2);
      } finally {
        await twinSource.close();
      }
    } finally {
      await env.storage.close();
    }
  }, 90000);

  test("8) yetkisiz hedef/kiracı/kapsam matrisi: 403/404/422 ve hiç yazım yok", async () => {
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(cleanPath);
      try {
        const plan = await planOf(env, source, mappings);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        const notesBefore = await countRows(env, "memory_notes");
        // Aynı kiracıda reader: 403.
        const reader: Identity = { userId: "reader-1", tenantId: "local" };
        await env.db
          .insertInto("users")
          .values({
            id: reader.userId,
            subject: reader.userId,
            display_name: reader.userId,
            created_at: FIXED_NOW,
          })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
        await env.db
          .insertInto("memberships")
          .values({
            tenant_id: "local",
            user_id: reader.userId,
            role: "reader",
          })
          .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
          .execute();
        const readerDenied = await rejection(() =>
          applyAgzImport({
            service: env.service,
            commits: env.commits,
            identity: reader,
            stageDir: staged.stageDir,
            sourcePath: cleanPath,
          }),
        );
        expect(readerDenied.code).toBe("forbidden");
        // Farklı kiracı: manifest hedef kiracısı uyuşmaz → 403.
        await env.db
          .insertInto("tenants")
          .values({ id: "tenant-b", name: "B", created_at: FIXED_NOW })
          .execute();
        await env.db
          .insertInto("users")
          .values({
            id: "owner-b",
            subject: "owner-b",
            display_name: "B",
            created_at: FIXED_NOW,
          })
          .execute();
        await env.db
          .insertInto("memberships")
          .values({
            tenant_id: "tenant-b",
            user_id: "owner-b",
            role: "founder",
          })
          .execute();
        const foreign: Identity = { userId: "owner-b", tenantId: "tenant-b" };
        const foreignDenied = await rejection(() =>
          applyAgzImport({
            service: env.service,
            commits: env.commits,
            identity: foreign,
            stageDir: staged.stageDir,
            sourcePath: cleanPath,
          }),
        );
        expect(foreignDenied.code).toBe("agz_target_mismatch");
        expect(foreignDenied.status).toBe(403);
        // Kapsam türü uyuşmazlığı: manifest eşlemesi bozulursa 422.
        const tamperedPlan = {
          manifest: {
            ...plan.manifest,
            mappings: plan.manifest.mappings.map((mapping, index) =>
              index === 0
                ? {
                    ...mapping,
                    target: {
                      ...mapping.target,
                      kind: "project" as const,
                      projectId: null,
                    },
                  }
                : mapping,
            ),
          },
          documents: plan.documents,
        };
        const tamperedStage = await stageAgzImport(tamperedPlan, {
          vaultRoot: env.vault,
        });
        const kindDenied = await rejection(() =>
          applyAgzImport({
            service: env.service,
            commits: env.commits,
            identity: env.owner,
            stageDir: tamperedStage.stageDir,
            sourcePath: cleanPath,
          }),
        );
        expect(kindDenied.code).toBe("agz_target_mismatch");
        expect(kindDenied.status).toBe(422);
        expect(await countRows(env, "memory_notes")).toBe(notesBefore);
        expect(await countRows(env, "memory_events")).toBe(0);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  }, 90000);
});

describe("M07 bağımsız envanter/şema ve migration güveni", () => {
  test("9) desteklenmeyen şema mutasyonsuz reddedilir; cursor/batch tüm kayıtları gezer", async () => {
    const dir = await freshDir("forge-m07-schema-");
    const futurePath = join(dir, "future.db");
    await buildUnsupportedSchemaFixture(futurePath, 12);
    const before = await fileSnapshot(futurePath);
    const error = await rejection(() => openAgzSource(futurePath));
    expect(error.code).toBe("unsupported_source_schema");
    expect((await fileSnapshot(futurePath)).sha256).toBe(before.sha256);

    const cursorDir = await freshDir("forge-m07-cursor-");
    const cursorPath = join(cursorDir, "agz.db");
    await buildAgzFixture(cursorPath, { profile: "clean" });
    const cleanSource = await sourceOf(cursorPath);
    try {
      // Sayfa sayfa tarama tam kümeyi ve ilerleyen cursor'ı verir.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = cleanSource.scanNotes({ cursor, limit: 2 });
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((note) => note.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(8);
      const revisions: string[] = [];
      cursor = null;
      for (;;) {
        const page = cleanSource.scanRevisions({ cursor, limit: 3 });
        revisions.push(
          ...page.items.map((rev) => `${rev.noteId}:${rev.revision}`),
        );
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(new Set(revisions).size).toBe(11);
    } finally {
      await cleanSource.close();
    }
  }, 60000);

  test("10) migration güvenilir türü fail-closed: sanitizasyon gerektiren içerik sessizce yazılmaz", async () => {
    const env = await openEnv();
    try {
      const space = await env.service.ensureSpace(env.owner, {
        type: "personal",
      });
      const content = [
        "---",
        "format_version: 1",
        'note_id: "migration-unsafe"',
        `memory_space_id: ${JSON.stringify(space.id)}`,
        "kind: note",
        'title: "Göç"',
        "---",
        "",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        "",
      ].join("\n");
      const event = (
        await env.service.recordEvent(env.owner, {
          spaceId: space.id,
          sourceEventKey: "migration-unsafe",
          sourceKind: "migration",
          contentHash: sha256Hex(content),
        })
      ).event;
      const denied = await rejection(() =>
        env.commits.commit({
          identity: env.owner,
          spaceId: space.id,
          eventId: event.id,
          sourceKind: "migration",
          content,
        }),
      );
      expect(denied.code).toBe("memory_unsafe_content");
      expect(denied.status).toBe(422);
      expect(await countRows(env, "memory_note_revisions")).toBe(0);
      expect(await countRows(env, "memory_notes")).toBe(0);
    } finally {
      await env.storage.close();
    }
  }, 30000);

  test("11) fixture üretimi byte-deterministik", async () => {
    const dirA = await freshDir("forge-m07-det-a-");
    const dirB = await freshDir("forge-m07-det-b-");
    const pathA = join(dirA, "agz.db");
    const pathB = join(dirB, "agz.db");
    await buildAgzFixture(pathA, { profile: "clean" });
    await buildAgzFixture(pathB, { profile: "clean" });
    expect((await fileSnapshot(pathA)).sha256).toBe(
      (await fileSnapshot(pathB)).sha256,
    );
  }, 60000);

  test("12) manifest şeması strict ve sürüm kapısı mutasyonsuz çalışır", async () => {
    const future = { manifestVersion: 2 } as unknown;
    const unsupported = await rejection(async () => verifyAgzManifest(future));
    expect(unsupported.code).toBe("unsupported_manifest");
    const broken = await rejection(async () =>
      parseAgzManifestJson('{"manifestVersion":1,"kind":"x"}'),
    );
    expect(broken.code).toBe("invalid_agz_manifest");
    const tampered = await rejection(async () =>
      parseAgzManifestJson("{bozuk json"),
    );
    expect(tampered.code).toBe("invalid_agz_manifest");
  });

  test.failing(
    "13) bekleyen: hostile note_id stage dizini dışına yol açmamalı",
    async () => {
      const env = await openEnv();
      try {
        const space = await env.service.ensureSpace(env.owner, {
          type: "personal",
        });
        const hostileId = "../../../../polluted";
        const content = "---\nformat_version: 1\n---\nGövde.\n";
        const documentSha = sha256Hex(content);
        const plan = {
          manifest: {
            manifestVersion: 1,
            kind: "agz-memory-import-manifest",
            createdAt: 1,
            generator: { product: "probe", module: "m07-agz-import" },
            source: {
              productId: "agz-memory",
              version: "0.5.2",
              commit: "x",
              schemaVersion: 11,
              hashPolicy: "hash-tuple/2",
              schemaFingerprint: "a".repeat(64),
              databaseId: "probe-db",
              fileSha256: "b".repeat(64),
              fileSizeBytes: 1,
              inventoryDigest: "c".repeat(64),
              journalMode: "delete",
              integrityCheck: "ok",
            },
            mappings: [
              {
                sourceProjectId: "p1",
                sourceName: "P",
                normalizedName: "p",
                target: {
                  tenantId: env.owner.tenantId,
                  memorySpaceId: space.id,
                  projectId: null,
                  kind: "personal" as const,
                },
              },
            ],
            notes: [
              {
                sourceProjectId: "p1",
                sourceNoteId: hostileId,
                targetNoteId: "victim",
                idDecision: "preserved" as const,
                idDecisionReason: null,
                title: "T",
                kind: "note",
                lifecycle: "active",
                pinned: false,
                status: "ready" as const,
                issues: [],
                revisions: [
                  {
                    sourceRevision: 1,
                    sourceContentHash: "d".repeat(64),
                    targetRevision: 1,
                    documentSha256,
                    recordHash: "e".repeat(64),
                    bytes: content.length,
                  },
                ],
                edges: [],
                provenanceCount: 0,
              },
            ],
            counts: {
              projects: 1,
              notes: 1,
              readyNotes: 1,
              quarantinedNotes: 0,
              revisions: 1,
              edges: 0,
              droppedEdges: 0,
              provenance: 0,
              pinned: 0,
            },
            exclusions: [],
            issues: [],
            decision: {
              status: "ready" as const,
              blockingIssues: 0,
              warningIssues: 0,
            },
          },
          documents: [
            {
              sourceProjectId: "p1",
              sourceNoteId: hostileId,
              sourceRevision: 1,
              relativePath: agzDocumentRelativePath(hostileId, 1, documentSha),
              content,
              sha256: documentSha,
              bytes: content.length,
            },
          ],
        };
        let threw = false;
        let stageDir = "";
        try {
          const staged = await stageAgzImport(
            plan as unknown as Parameters<typeof stageAgzImport>[0],
            { vaultRoot: env.vault },
          );
          stageDir = staged.stageDir;
        } catch {
          threw = true;
        }
        const files = await listVaultFiles(env.vault).catch(() => []);
        const stagePrefix = stageDir
          ? stageDir
              .slice(env.vault.length + 1)
              .split("/")
              .join("/")
          : null;
        const outsideStage = files.filter(
          (file) => !stagePrefix || !file.startsWith(`${stagePrefix}/`),
        );
        expect(threw || outsideStage.length === 0).toBe(true);
      } finally {
        await env.storage.close();
      }
    },
    30000,
  );

  test.failing(
    "14) bekleyen: rollback sonrası replay 'already_applied' dememeli, tombstone görünür olmalı",
    async () => {
      const env = await openEnv();
      const dir = await freshDir("forge-m07-replay-");
      const fixturePath = join(dir, "agz.db");
      await buildAgzFixture(fixturePath, { profile: "clean" });
      const source = await sourceOf(fixturePath);
      try {
        const mappings = await bindMappings(env);
        const plan = await planOf(env, source, mappings);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: fixturePath,
        });
        const rolled = await rollbackAgzImport({
          service: env.service,
          identity: env.owner,
          stageDir: staged.stageDir,
        });
        expect(rolled.counters.rolledBack).toBeGreaterThan(0);
        const replay = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: fixturePath,
        });
        // Replay, arşivlenmiş 7 hedefe rağmen tam başarı bildirmemeli.
        expect(replay.status).not.toBe("already_applied");
        expect(replay.counters.notes.duplicate).toBeLessThan(8);
      } finally {
        await source.close();
        await env.storage.close();
      }
    },
    90000,
  );
});
