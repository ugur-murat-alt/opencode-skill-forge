/**
 * #40 / M07 FAZ 2 kabul testleri: dry-run → stage → apply → doğrulama →
 * rollback akışı, gerçek #35 (M02) commit hattı üzerinden.
 *
 * Kaynak her zaman test fixture'ıdır; canlı AGZ verisi, tokenı veya gerçek DB
 * yolu kullanılmaz. Hedef, geçici dizinde açılan gerçek SQLite + vault'tur.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { sha256Hex } from "../src/memory/files.js";
import { vaultRoot } from "../src/memory/paths.js";
import { MemoryService } from "../src/memory/service.js";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { openAgzSource, type AgzSource } from "../src/memory/agz/inventory.js";
import {
  AGZ_MANIFEST_VERSION,
  deterministicAgzNoteId,
  ensureAgzTargetSpace,
  planAgzImport,
  verifyAgzManifest,
  type AgzImportManifest,
  type AgzImportPlan,
  type AgzProjectMapping,
} from "../src/memory/agz/manifest.js";
import {
  applyAgzImport,
  readAgzStage,
  rollbackAgzImport,
  stageAgzImport,
  type AgzApplyReport,
} from "../src/memory/agz/pipeline.js";
import { compareAgzShadow } from "../src/memory/agz/shadow.js";
import {
  AGZ_FIXTURE_IDS,
  buildAgzFixture,
  fileSnapshot,
} from "./fixtures/agz/buildAgzFixture.js";

const FIXED_NOW = 1_775_000_000_000;
// Gerçek SQLite/vault kurulumu tam takım yükü altında 5 sn'yi aşabilir.
setDefaultTimeout(60_000);

interface TestEnv {
  root: string;
  storage: DatabaseHandle;
  db: DatabaseHandle["db"];
  vault: string;
  identities: IdentityService;
  owner: Identity;
  service: MemoryService;
  commits: MemoryCommitService;
}

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function openEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), "forge-m07-"));
  roots.push(root);
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

async function closeEnv(env: TestEnv): Promise<void> {
  await env.storage.close();
}

async function bindProjects(
  env: TestEnv,
  options: { alphaKind?: "personal" | "organization" } = {},
): Promise<AgzProjectMapping[]> {
  const alphaKind = options.alphaKind ?? "personal";
  const alpha = await ensureAgzTargetSpace({
    service: env.service,
    identity: env.owner,
    sourceProjectId: AGZ_FIXTURE_IDS.projectAlpha,
    sourceName: "Proje Alfa",
    normalizedName: "proje alfa",
    kind: alphaKind,
    organizationName: "AGZ Proje Alfa",
  });
  const beta = await ensureAgzTargetSpace({
    service: env.service,
    identity: env.owner,
    sourceProjectId: AGZ_FIXTURE_IDS.projectBeta,
    sourceName: "Proje Beta",
    normalizedName: "proje beta",
    kind: "organization",
    organizationName: "AGZ Proje Beta",
  });
  const archive = await ensureAgzTargetSpace({
    service: env.service,
    identity: env.owner,
    sourceProjectId: AGZ_FIXTURE_IDS.projectArchive,
    sourceName: "Arşiv Projesi",
    normalizedName: "arsiv projesi",
    kind: "organization",
    organizationName: "AGZ Arşiv",
  });
  return [alpha, beta, archive];
}

async function sourceOf(path: string): Promise<AgzSource> {
  return openAgzSource(path, { now: () => FIXED_NOW });
}

async function countRows(
  env: TestEnv,
  table: "memory_notes" | "memory_note_revisions" | "memory_events",
): Promise<number> {
  const row = await env.db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function humanEdit(
  env: TestEnv,
  spaceId: string,
  noteId: string,
  newBody: string,
): Promise<{ revision: number; content: string }> {
  const current = await env.service.readNote(env.owner, { spaceId, noteId });
  if (!current.content || current.note.current_revision === null)
    throw new Error("edit için kabul edilmiş içerik yok");
  const marker = current.content.indexOf("\n---\n");
  if (marker < 0) throw new Error("frontmatter kapanışı bulunamadı");
  const updated = `${current.content.slice(0, marker + 5)}${newBody}\n`;
  const outcome = await env.service.recordEvent(env.owner, {
    spaceId,
    sourceEventKey: `human-edit-${randomUUID()}`,
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
  return { revision: receipt.revision, content: updated };
}

// ---------------------------------------------------------------------------

describe("M07 FAZ 2: plan / dry-run", () => {
  let env: TestEnv;
  let cleanPath: string;
  let source: AgzSource;
  let mappings: AgzProjectMapping[];

  beforeAll(async () => {
    env = await openEnv();
    const fixtureRoot = await mkdtemp(join(tmpdir(), "forge-m07-fixtures-"));
    roots.push(fixtureRoot);
    cleanPath = join(fixtureRoot, "agz-clean.db");
    await buildAgzFixture(cleanPath, { profile: "clean" });
    source = await sourceOf(cleanPath);
    mappings = await bindProjects(env);
  });

  afterAll(async () => {
    await source.close();
    await closeEnv(env);
  });

  test("dry-run planı kaynak kimliğini, açık eşlemeyi ve plan hash'lerini taşır; hiçbir yazım yapmaz", async () => {
    const beforeNotes = await countRows(env, "memory_notes");
    const beforeEvents = await countRows(env, "memory_events");
    const plan = await planAgzImport({
      source,
      targetDb: env.db,
      mappings,
      now: () => FIXED_NOW,
    });

    expect(plan.manifest.manifestVersion).toBe(AGZ_MANIFEST_VERSION);
    expect(plan.manifest.kind).toBe("agz-memory-import-manifest");
    expect(plan.manifest.createdAt).toBe(FIXED_NOW);
    expect(plan.manifest.source.databaseId).toBe(AGZ_FIXTURE_IDS.databaseId);
    expect(plan.manifest.source.schemaVersion).toBe(11);
    expect(plan.manifest.source.hashPolicy).toBe("hash-tuple/2");
    expect(plan.manifest.source.schemaFingerprint).toBe(
      "8d63948dcdfd5404a3e555fe9a194866f4c03cb6825dca503063f4797a57a888",
    );
    expect(plan.manifest.source.fileSha256).toBe(
      (await fileSnapshot(cleanPath)).sha256,
    );
    expect(plan.manifest.counts).toMatchObject({
      notes: 8,
      readyNotes: 8,
      quarantinedNotes: 0,
      revisions: 11,
      edges: 6,
      provenance: 11,
      pinned: 2,
    });
    expect(plan.manifest.decision).toEqual({
      status: "ready",
      blockingIssues: 0,
      warningIssues: 0,
    });
    expect(plan.manifest.mappings).toHaveLength(3);
    for (const note of plan.manifest.notes) {
      expect(note.status).toBe("ready");
      expect(note.idDecision).toBe("preserved");
      expect(note.targetNoteId).toBe(note.sourceNoteId);
      expect(note.revisions.map((revision) => revision.targetRevision)).toEqual(
        note.revisions.map((_, index) => index + 1),
      );
      for (const revision of note.revisions) {
        expect(revision.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(revision.documentSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(revision.recordHash).toMatch(/^[0-9a-f]{64}$/);
        expect(revision.bytes).toBeGreaterThan(0);
      }
    }
    expect(plan.documents).toHaveLength(11);
    expect(
      plan.documents.find(
        (document) => document.sourceNoteId === AGZ_FIXTURE_IDS.noteUnicode,
      )?.content,
    ).toContain("Ünicode Başlık 🧠 — ğüşiöçİı");

    // Dry-run hiçbir hedef satır ve stage dosyası üretmez.
    expect(await countRows(env, "memory_notes")).toBe(beforeNotes);
    expect(await countRows(env, "memory_events")).toBe(beforeEvents);
    await expect(
      readFile(join(env.vault, "imports"), "utf8"),
    ).rejects.toThrow();
    const sourceHash = await fileSnapshot(cleanPath);
    expect(sourceHash.sha256).toBe(plan.manifest.source.fileSha256);
  });

  test("aynı başlık farklı UUID ayrı not; aynı not UUID farklı DB deterministik remap", async () => {
    const basePlan = await planAgzImport({
      source,
      targetDb: env.db,
      mappings,
      now: () => FIXED_NOW,
    });
    const base = basePlan.manifest.notes;
    const rule = base.find(
      (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
    );
    const duplicateTitle = base.find(
      (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteDuplicateTitle,
    );
    expect(rule?.targetNoteId).not.toBe(duplicateTitle?.targetNoteId);
    expect(rule?.targetNoteId).toBe(AGZ_FIXTURE_IDS.noteRule);
    expect(duplicateTitle?.targetNoteId).toBe(
      AGZ_FIXTURE_IDS.noteDuplicateTitle,
    );

    // Temel import uygulanır: hedefte aynı not UUID'si artık bu kaynağa ait.
    const baseStage = await stageAgzImport(basePlan, { vaultRoot: env.vault });
    await applyAgzImport({
      service: env.service,
      commits: env.commits,
      identity: env.owner,
      stageDir: baseStage.stageDir,
      sourcePath: cleanPath,
    });

    const fixtureRoot = await mkdtemp(join(tmpdir(), "forge-m07-twins-"));
    roots.push(fixtureRoot);
    const twinPath = join(fixtureRoot, "agz-twin.db");
    await buildAgzFixture(twinPath, { variant: "twin", profile: "clean" });
    const twinSource = await sourceOf(twinPath);
    try {
      // Aynı ad, farklı proje UUID'si: eşleme açıkça twin UUID'siyle verilir,
      // ad benzerliği otomatik eşleme değildir.
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
      const twinPlan = await planAgzImport({
        source: twinSource,
        targetDb: env.db,
        mappings: twinMappings,
        now: () => FIXED_NOW,
      });
      const twinRule = twinPlan.manifest.notes.find(
        (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
      );
      expect(twinRule?.idDecision).toBe("remapped");
      expect(twinRule?.targetNoteId).not.toBe(AGZ_FIXTURE_IDS.noteRule);
      expect(twinRule?.targetNoteId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(twinPlan.manifest.source.databaseId).toBe(
        AGZ_FIXTURE_IDS.twinDatabaseId,
      );

      // Deterministik: aynı plan yeniden üretildiğinde aynı hedef kimlik.
      const twinAgain = await planAgzImport({
        source: twinSource,
        targetDb: env.db,
        mappings: twinMappings,
        now: () => FIXED_NOW,
      });
      expect(
        twinAgain.manifest.notes.find(
          (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
        )?.targetNoteId,
      ).toBe(twinRule?.targetNoteId);

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
      const ruleRows = await env.db
        .selectFrom("memory_notes")
        .selectAll()
        .where("space_id", "=", alphaSpace)
        .where("id", "in", [AGZ_FIXTURE_IDS.noteRule, twinRule!.targetNoteId])
        .execute();
      expect(ruleRows).toHaveLength(2);
      const twinRevision = await env.db
        .selectFrom("memory_note_revisions")
        .select(["content_hash"])
        .where("space_id", "=", alphaSpace)
        .where("note_id", "=", twinRule!.targetNoteId)
        .executeTakeFirstOrThrow();
      const baseRevision = await env.db
        .selectFrom("memory_note_revisions")
        .select(["content_hash"])
        .where("space_id", "=", alphaSpace)
        .where("note_id", "=", AGZ_FIXTURE_IDS.noteRule)
        .executeTakeFirstOrThrow();
      expect(twinRevision.content_hash).not.toBe(baseRevision.content_hash);
    } finally {
      await twinSource.close();
    }
  });

  test("eşlenmemiş proje blocked kararı verir; kısmi manifestte karantina listelenir", async () => {
    const partial = mappings.slice(0, 1);
    const plan = await planAgzImport({
      source,
      targetDb: env.db,
      mappings: partial,
      now: () => FIXED_NOW,
    });
    expect(plan.manifest.decision.status).toBe("blocked");
    expect(
      plan.manifest.issues.some((issue) => issue.code === "unmapped_project"),
    ).toBe(true);
  });
});

describe("M07 FAZ 2: stage ve apply", () => {
  let env: TestEnv;
  let cleanPath: string;
  let negativePath: string;
  let mappings: AgzProjectMapping[];

  beforeAll(async () => {
    env = await openEnv();
    const fixtureRoot = await mkdtemp(join(tmpdir(), "forge-m07-stage-"));
    roots.push(fixtureRoot);
    cleanPath = join(fixtureRoot, "agz-clean.db");
    negativePath = join(fixtureRoot, "agz-negative.db");
    await buildAgzFixture(cleanPath, { profile: "clean" });
    await buildAgzFixture(negativePath, { profile: "negative" });
    mappings = await bindProjects(env);
  });

  afterAll(async () => {
    await closeEnv(env);
  });

  test("clean fixture: stage doğrulanır, apply yetkili commit hattından geçer, shadow eşleşir", async () => {
    const source = await sourceOf(cleanPath);
    const sourceHashBefore = (await fileSnapshot(cleanPath)).sha256;
    let plan: AgzImportPlan;
    let report: AgzApplyReport;
    try {
      plan = await planAgzImport({
        source,
        targetDb: env.db,
        mappings,
        now: () => FIXED_NOW,
      });
      const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
      const stage = await readAgzStage({ stageDir: staged.stageDir });
      expect(stage.manifest.source.fileSha256).toBe(sourceHashBefore);
      expect(stage.documents.size).toBe(11);
      expect(staged.documentCount).toBe(11);

      report = await applyAgzImport({
        service: env.service,
        commits: env.commits,
        identity: env.owner,
        stageDir: staged.stageDir,
        sourcePath: cleanPath,
      });

      const shadow = await compareAgzShadow({
        service: env.service,
        identity: env.owner,
        vaultRoot: env.vault,
        manifest: plan.manifest,
      });
      expect(shadow.decision).toBe("match");
      expect(shadow.missingNotes).toEqual([]);
      expect(shadow.mismatched).toEqual([]);
      expect(shadow.source).toMatchObject({
        notes: 8,
        revisions: 11,
        edges: 6,
        pinned: 2,
      });
      expect(shadow.excluded.map((entry) => entry.table)).toContain(
        "capture_events",
      );
      expect(shadow.excluded.map((entry) => entry.table)).toContain(
        "index_outbox",
      );
    } finally {
      await source.close();
    }

    expect(report.status).toBe("applied");
    expect(report.counters.notes).toMatchObject({
      planned: 8,
      applied: 8,
      duplicate: 0,
      quarantined: 0,
      conflict: 0,
      failed: 0,
    });
    expect(report.counters.revisions).toMatchObject({
      planned: 11,
      applied: 11,
      duplicate: 0,
      quarantined: 0,
      conflict: 0,
      failed: 0,
    });
    expect(await countRows(env, "memory_notes")).toBe(8);
    expect(await countRows(env, "memory_note_revisions")).toBe(11);
    expect(await countRows(env, "memory_events")).toBe(11);

    const alphaSpace = mappings[0]!.target.memorySpaceId;
    const notes = await env.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("space_id", "=", alphaSpace)
      .execute();
    expect(notes).toHaveLength(6);
    expect(notes.filter((note) => note.pinned === 1)).toHaveLength(1);
    expect(notes.map((note) => note.lifecycle).sort()).toEqual([
      "active",
      "active",
      "active",
      "archived",
      "archived",
      "superseded",
    ]);
    const rule = notes.find((note) => note.id === AGZ_FIXTURE_IDS.noteRule);
    expect(rule?.title).toBe("Kimlik Eşleme Kuralı");
    expect(rule?.current_revision).toBe(1);

    // Revision dosyaları stage hash'leriyle birebir ve olaylar migration türünde.
    const revisions = await env.db
      .selectFrom("memory_note_revisions")
      .selectAll()
      .where("space_id", "=", alphaSpace)
      .execute();
    for (const revision of revisions) {
      expect(revision.file_path).toMatch(/^spaces\//);
      expect(revision.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(revision.byte_size).toBeGreaterThan(0);
      const absolute = join(env.vault, revision.file_path!);
      const content = await readFile(absolute, "utf8");
      expect(sha256Hex(content)).toBe(revision.content_hash);
    }
    const events = await env.db
      .selectFrom("memory_events")
      .selectAll()
      .where("space_id", "=", alphaSpace)
      .execute();
    expect(events.every((event) => event.source_kind === "migration")).toBe(
      true,
    );
    expect(
      events.every((event) =>
        event.source_event_key?.startsWith(
          `agz:${AGZ_FIXTURE_IDS.databaseId}:`,
        ),
      ),
    ).toBe(true);
    expect(events.every((event) => event.state === "committed")).toBe(true);

    // Kaynak snapshot değişmezliği: hash aynı, WAL/SHM yok.
    expect((await fileSnapshot(cleanPath)).sha256).toBe(sourceHashBefore);
  });

  test("tekrar aynı import yeni not/revision/olay çoğaltmaz", async () => {
    const source = await sourceOf(cleanPath);
    try {
      const plan = await planAgzImport({
        source,
        targetDb: env.db,
        mappings,
        now: () => FIXED_NOW,
      });
      const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
      const notesBefore = await countRows(env, "memory_notes");
      const revisionsBefore = await countRows(env, "memory_note_revisions");
      const eventsBefore = await countRows(env, "memory_events");
      const second = await applyAgzImport({
        service: env.service,
        commits: env.commits,
        identity: env.owner,
        stageDir: staged.stageDir,
        sourcePath: cleanPath,
      });
      expect(notesBefore).toBe(8);
      expect(await countRows(env, "memory_notes")).toBe(notesBefore);
      expect(await countRows(env, "memory_note_revisions")).toBe(
        revisionsBefore,
      );
      expect(await countRows(env, "memory_events")).toBe(eventsBefore);
      expect(second.status).toBe("already_applied");
      expect(second.counters.notes.duplicate).toBe(8);
      expect(second.counters.revisions.applied).toBe(0);
      expect(second.counters.revisions.duplicate).toBe(11);
    } finally {
      await source.close();
    }
  });

  test("stage dokümanı bozulursa apply reddeder ve hedefe yazmaz", async () => {
    const source = await sourceOf(negativePath);
    try {
      const plan = await planAgzImport({
        source,
        targetDb: env.db,
        mappings,
        now: () => FIXED_NOW,
      });
      const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
      const stage = await readAgzStage({ stageDir: staged.stageDir });
      const victim = [...stage.documents.values()][0]!;
      await writeFile(
        join(staged.stageDir, victim.relativePath),
        `${victim.content}BOZUK`,
      );
      const before = await countRows(env, "memory_notes");
      let caught: unknown;
      try {
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: negativePath,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "agz_stage_integrity" });
      expect(await countRows(env, "memory_notes")).toBe(before);
    } finally {
      await source.close();
    }
  });

  test("kaynak snapshot değiştiyse eski stage sessizce uygulanmaz", async () => {
    const source = await sourceOf(cleanPath);
    try {
      const plan = await planAgzImport({
        source,
        targetDb: env.db,
        mappings,
        now: () => FIXED_NOW,
      });
      const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
      const before = await countRows(env, "memory_notes");
      let caught: unknown;
      try {
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          // Aynı ADI taşıyan ama farklı baytlar içeren snapshot:
          sourcePath: negativePath,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "source_changed_during_scan" });
      expect(await countRows(env, "memory_notes")).toBe(before);
    } finally {
      await source.close();
    }
  });

  test("yetkisiz hedef apply öncesi reddedilir; hiçbir satır yazılmaz", async () => {
    const source = await sourceOf(cleanPath);
    const stranger: Identity = { userId: "user-2", tenantId: "local" };
    await env.db
      .insertInto("users")
      .values({
        id: stranger.userId,
        subject: "user-2",
        display_name: "İkinci kullanıcı",
        created_at: FIXED_NOW,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await env.db
      .insertInto("memberships")
      .values({ tenant_id: "local", user_id: stranger.userId, role: "reader" })
      .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
      .execute();
    try {
      const plan = await planAgzImport({
        source,
        targetDb: env.db,
        mappings,
        now: () => FIXED_NOW,
      });
      const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
      const before = await countRows(env, "memory_notes");
      const eventsBefore = await countRows(env, "memory_events");
      let caught: unknown;
      try {
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: stranger,
          stageDir: staged.stageDir,
          sourcePath: cleanPath,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "forbidden" });
      expect(await countRows(env, "memory_notes")).toBe(before);
      expect(await countRows(env, "memory_events")).toBe(eventsBefore);
    } finally {
      await source.close();
    }
  });

  test("negatif fixture: sağlam notlar uygulanır, bozuklar karantinada kalır", async () => {
    const negativeEnv = await openEnv();
    try {
      const mappings = await bindProjects(negativeEnv);
      const source = await sourceOf(negativePath);
      try {
        const plan = await planAgzImport({
          source,
          targetDb: negativeEnv.db,
          mappings,
          now: () => FIXED_NOW,
        });
        expect(plan.manifest.decision.status).toBe("partial");
        const quarantined = plan.manifest.notes.filter(
          (note) => note.status === "quarantined",
        );
        expect(quarantined.map((note) => note.sourceNoteId).sort()).toEqual(
          [
            AGZ_FIXTURE_IDS.noteCurrentProcedure,
            AGZ_FIXTURE_IDS.noteOrphan,
            AGZ_FIXTURE_IDS.noteArchivedGap,
          ].sort(),
        );
        expect(plan.manifest.counts.droppedEdges).toBe(4);

        const staged = await stageAgzImport(plan, {
          vaultRoot: negativeEnv.vault,
        });
        const report = await applyAgzImport({
          service: negativeEnv.service,
          commits: negativeEnv.commits,
          identity: negativeEnv.owner,
          stageDir: staged.stageDir,
          sourcePath: negativePath,
        });
        expect(report.status).toBe("partial");
        expect(report.counters.notes.quarantined).toBe(3);
        expect(report.counters.notes.applied).toBe(7);

        const noteIds = await negativeEnv.db
          .selectFrom("memory_notes")
          .select("id")
          .execute();
        const ids = noteIds.map((row) => row.id);
        expect(ids).not.toContain(AGZ_FIXTURE_IDS.noteOrphan);
        expect(ids).not.toContain(AGZ_FIXTURE_IDS.noteArchivedGap);
        expect(ids).toContain(AGZ_FIXTURE_IDS.noteRule);

        const shadow = await compareAgzShadow({
          service: negativeEnv.service,
          identity: negativeEnv.owner,
          vaultRoot: negativeEnv.vault,
          manifest: plan.manifest,
        });
        expect(
          shadow.quarantined.map((entry) => entry.sourceNoteId).sort(),
        ).toEqual(
          [
            AGZ_FIXTURE_IDS.noteCurrentProcedure,
            AGZ_FIXTURE_IDS.noteOrphan,
            AGZ_FIXTURE_IDS.noteArchivedGap,
          ].sort(),
        );
        expect(shadow.decision).toBe("match");
      } finally {
        await source.close();
      }
    } finally {
      await closeEnv(negativeEnv);
    }
  });
});

describe("M07 FAZ 2: crash, resume ve rollback", () => {
  let env: TestEnv;
  let cleanPath: string;

  beforeAll(async () => {
    env = await openEnv();
    const fixtureRoot = await mkdtemp(join(tmpdir(), "forge-m07-resume-"));
    roots.push(fixtureRoot);
    cleanPath = join(fixtureRoot, "agz-clean.db");
    await buildAgzFixture(cleanPath, { profile: "clean" });
  });

  afterAll(async () => {
    await closeEnv(env);
  });

  test("apply sırasında crash sonrası devam çoğaltmaz ve receipt tamamlanır", async () => {
    const mappings = await bindProjects(env);
    const source = await sourceOf(cleanPath);
    let stageDir = "";
    try {
      const plan = await planAgzImport({
        source,
        targetDb: env.db,
        mappings,
        now: () => FIXED_NOW,
      });
      stageDir = (await stageAgzImport(plan, { vaultRoot: env.vault }))
        .stageDir;

      let crash = true;
      let caught: unknown;
      try {
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir,
          sourcePath: cleanPath,
          hooks: {
            afterItem: () => {
              if (crash) {
                crash = false;
                throw new Error("simüle çökme: apply yarıda kaldı");
              }
            },
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const afterCrashNotes = await countRows(env, "memory_notes");
      expect(afterCrashNotes).toBeGreaterThan(0);
      expect(afterCrashNotes).toBeLessThan(8);

      const resumed = await applyAgzImport({
        service: env.service,
        commits: env.commits,
        identity: env.owner,
        stageDir,
        sourcePath: cleanPath,
      });
      expect(resumed.status).toBe("applied");
      expect(await countRows(env, "memory_notes")).toBe(8);
      expect(await countRows(env, "memory_note_revisions")).toBe(11);
      expect(await countRows(env, "memory_events")).toBe(11);
      const receipt = JSON.parse(
        await readFile(join(stageDir, "receipt.json"), "utf8"),
      ) as { counters: Record<string, number> };
      expect(
        receipt.counters.notes.applied + receipt.counters.notes.duplicate,
      ).toBe(8);
    } finally {
      await source.close();
    }
  });

  test("rollback değişmemiş aktarımları geri alır, insan düzenlemesini korur", async () => {
    const rollbackEnv = await openEnv();
    try {
      const mappings = await bindProjects(rollbackEnv);
      const source = await sourceOf(cleanPath);
      try {
        const plan = await planAgzImport({
          source,
          targetDb: rollbackEnv.db,
          mappings,
          now: () => FIXED_NOW,
        });
        const staged = await stageAgzImport(plan, {
          vaultRoot: rollbackEnv.vault,
        });
        await applyAgzImport({
          service: rollbackEnv.service,
          commits: rollbackEnv.commits,
          identity: rollbackEnv.owner,
          stageDir: staged.stageDir,
          sourcePath: cleanPath,
        });

        const alphaSpace = mappings[0]!.target.memorySpaceId;
        const edited = await humanEdit(
          rollbackEnv,
          alphaSpace,
          AGZ_FIXTURE_IDS.noteRule,
          "Kullanıcı bu notu aktarımdan sonra düzenledi.\n",
        );
        const sourceHashBefore = (await fileSnapshot(cleanPath)).sha256;

        const report = await rollbackAgzImport({
          service: rollbackEnv.service,
          identity: rollbackEnv.owner,
          stageDir: staged.stageDir,
        });
        expect(report.counters.rolledBack).toBeGreaterThan(0);
        expect(report.counters.conflict).toBe(1);
        const editedItem = report.items.find(
          (item) => item.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
        );
        expect(editedItem?.status).toBe("conflict");

        const note = await rollbackEnv.db
          .selectFrom("memory_notes")
          .selectAll()
          .where("space_id", "=", alphaSpace)
          .where("id", "=", AGZ_FIXTURE_IDS.noteRule)
          .executeTakeFirstOrThrow();
        expect(note.deleted_at).toBeNull();
        expect(note.current_revision).toBe(edited.revision);

        const preference = await rollbackEnv.db
          .selectFrom("memory_notes")
          .selectAll()
          .where("id", "=", AGZ_FIXTURE_IDS.notePreference)
          .executeTakeFirstOrThrow();
        expect(preference.deleted_at).not.toBeNull();

        const second = await rollbackAgzImport({
          service: rollbackEnv.service,
          identity: rollbackEnv.owner,
          stageDir: staged.stageDir,
        });
        expect(second.status).toBe("partial");
        expect(second.counters.rolledBack).toBe(0);
        expect(second.counters.alreadyRolledBack).toBe(7);
        expect(second.counters.conflict).toBe(1);
        expect((await fileSnapshot(cleanPath)).sha256).toBe(sourceHashBefore);
      } finally {
        await source.close();
      }
    } finally {
      await closeEnv(rollbackEnv);
    }
  });
});

describe("M07 FAZ 2: manifest sözleşmesi", () => {
  test("deterministik not kimliği kaynak kimliğine bağlıdır", () => {
    const first = deterministicAgzNoteId(
      AGZ_FIXTURE_IDS.databaseId,
      AGZ_FIXTURE_IDS.projectAlpha,
      AGZ_FIXTURE_IDS.noteRule,
    );
    expect(first).toBe(
      deterministicAgzNoteId(
        AGZ_FIXTURE_IDS.databaseId,
        AGZ_FIXTURE_IDS.projectAlpha,
        AGZ_FIXTURE_IDS.noteRule,
      ),
    );
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first).not.toBe(
      deterministicAgzNoteId(
        AGZ_FIXTURE_IDS.twinDatabaseId,
        AGZ_FIXTURE_IDS.projectAlpha,
        AGZ_FIXTURE_IDS.noteRule,
      ),
    );
  });

  test("bilinmeyen manifest sürümü ve bozuk şema reddedilir", () => {
    const base: AgzImportManifest = {
      manifestVersion: 2 as unknown as 1,
      kind: "agz-memory-import-manifest",
    } as AgzImportManifest;
    let caught: unknown;
    try {
      verifyAgzManifest(base);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "unsupported_manifest" });
  });
});
