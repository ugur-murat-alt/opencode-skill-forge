/**
 * M07 (#40) bağımsız doğrulama bulguları için regresyon testleri.
 *
 * Bu dosya çekirdek düzeltmeleri TDD ile sabitler:
 *  - hostile/kurcalanmış not kimliği stage dizini dışına yol açamaz,
 *  - rollback sonrası replay sessiz "duplicate başarı" veremez; tombstone
 *    açık sonuç üretir ve diriltilmez,
 *  - rollback receipt-stage digest bağını doğrular,
 *  - sahiplik tespiti LIKE yerine literal önek karşılaştırması kullanır.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  agzDocumentRelativePath,
  agzIdempotencyKey,
  isAgzOwnedSourceKey,
  planAgzImport,
  type AgzImportPlan,
  type AgzProjectMapping,
} from "../src/memory/agz/manifest.js";
import {
  applyAgzImport,
  rollbackAgzImport,
  stageAgzImport,
} from "../src/memory/agz/pipeline.js";
import {
  AGZ_FIXTURE_IDS,
  buildAgzFixture,
} from "./fixtures/agz/buildAgzFixture.js";
import { openWritableSqlite } from "../src/memory/agz/sqlite-driver.js";

const FIXED_NOW = 1_776_000_000_000;
const roots: string[] = [];

// Gerçek SQLite/vault kurulumu tam takım yükü altında 5 sn'yi aşabilir;
// testler kendi başına deterministik kalır.
setDefaultTimeout(60_000);

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Env {
  root: string;
  storage: DatabaseHandle;
  vault: string;
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
  const root = await freshDir("forge-m07-guards-");
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
  return { root, storage, vault, owner, service, commits };
}

async function bindMappings(env: Env): Promise<AgzProjectMapping[]> {
  const { ensureAgzTargetSpace } =
    await import("../src/memory/agz/manifest.js");
  return [
    await ensureAgzTargetSpace({
      service: env.service,
      identity: env.owner,
      sourceProjectId: AGZ_FIXTURE_IDS.projectAlpha,
      sourceName: "Proje Alfa",
      normalizedName: "proje alfa",
      kind: "personal",
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
): Promise<AgzImportPlan> {
  return planAgzImport({
    source,
    targetDb: env.storage.db,
    mappings,
    now: () => FIXED_NOW,
  });
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
    return error as { code?: string; status?: number };
  }
  throw new Error("red beklenirken çağrı başarılı oldu");
}

/** Kurcalanmış plan: hostile not kimliğiyle "hazır" tek not. */
function hostilePlan(memorySpaceId: string, noteId: string): AgzImportPlan {
  const content = "---\nformat_version: 1\n---\nGövde.\n";
  const documentSha = sha256Hex(content);
  return {
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
            tenantId: "local",
            memorySpaceId,
            projectId: null,
            kind: "personal",
          },
        },
      ],
      notes: [
        {
          sourceProjectId: "p1",
          sourceNoteId: noteId,
          targetNoteId: "victim",
          idDecision: "preserved",
          idDecisionReason: null,
          title: "T",
          kind: "note",
          lifecycle: "active",
          pinned: false,
          status: "ready",
          issues: [],
          revisions: [
            {
              sourceRevision: 1,
              sourceContentHash: "d".repeat(64),
              targetRevision: 1,
              documentSha256: documentSha,
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
      decision: { status: "ready", blockingIssues: 0, warningIssues: 0 },
    },
    documents: [
      {
        sourceProjectId: "p1",
        sourceNoteId: noteId,
        sourceRevision: 1,
        relativePath: agzDocumentRelativePath(noteId, 1, documentSha),
        content,
        sha256: documentSha,
        bytes: content.length,
      },
    ],
  };
}

describe("M07 hostile note_id savunması", () => {
  test("agzDocumentRelativePath hostile kimliği ham yola gömmez", () => {
    const hostile = "../../../../polluted";
    const path = agzDocumentRelativePath(hostile, 1, "f".repeat(64));
    expect(path.startsWith("documents/")).toBe(true);
    expect(path).not.toContain("..");
    expect(path).not.toContain("polluted");
    expect(path).toMatch(/^documents\/x-[0-9a-f]{32}\/1-f{64}\.md$/);
    // Deterministik ve kimliğe bağlı.
    expect(agzDocumentRelativePath(hostile, 1, "f".repeat(64))).toBe(path);
    expect(agzDocumentRelativePath(`${hostile}x`, 1, "f".repeat(64))).not.toBe(
      path,
    );
    // Güvenli kimlik okunur kalır.
    expect(
      agzDocumentRelativePath(AGZ_FIXTURE_IDS.noteRule, 2, "f".repeat(64)),
    ).toBe(`documents/${AGZ_FIXTURE_IDS.noteRule}/2-${"f".repeat(64)}.md`);
  });

  test("hazır notta hostile kimlik stage öncesi reddedilir; hiçbir dosya yazılmaz", async () => {
    const env = await openEnv();
    try {
      const space = await env.service.ensureSpace(env.owner, {
        type: "personal",
      });
      const plan = hostilePlan(space.id, "../../../../polluted");
      const error = await rejection(() =>
        stageAgzImport(plan, { vaultRoot: env.vault }),
      );
      expect(error.code).toBe("agz_hostile_note_id");
      // Stage hiçbir şey yazmadı: vault içinde hiç dosya yok.
      expect(await listVaultFiles(env.vault).catch(() => [])).toEqual([]);
    } finally {
      await env.storage.close();
    }
  });

  test("envanterdeki hostile kimlik manifestte karantinaya alınır; diğer notlar uygulanır", async () => {
    const dir = await freshDir("forge-m07-hostile-");
    const fixturePath = join(dir, "agz.db");
    await buildAgzFixture(fixturePath, { profile: "clean" });
    // Kurcalanmış kaynak: geçerli AGZ şemasında hostile kimliği olan not.
    const db = await openWritableSqlite(fixturePath);
    try {
      db.run(
        `INSERT INTO notes
           (id, project_id, kind, title, summary, content, size_class, pinned, status,
            supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
         VALUES (?, ?, 'fact', 'Hostile', '', '', 'inline', 0, 'active', NULL, 1, NULL, ?, ?, ?)`,
        [
          "../../../../polluted",
          AGZ_FIXTURE_IDS.projectAlpha,
          "9".repeat(64),
          FIXED_NOW,
          FIXED_NOW,
        ],
      );
    } finally {
      db.close();
    }
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(fixturePath);
      try {
        const plan = await planOf(env, source, mappings);
        const hostile = plan.manifest.notes.find(
          (note) => note.sourceNoteId === "../../../../polluted",
        );
        expect(hostile?.status).toBe("quarantined");
        expect(
          hostile?.issues.some((issue) => issue.code === "agz_hostile_note_id"),
        ).toBe(true);
        expect(plan.manifest.counts.readyNotes).toBe(8);
        expect(plan.manifest.counts.quarantinedNotes).toBe(1);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        const report = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: fixturePath,
        });
        expect(report.counters.notes.applied).toBe(8);
        expect(report.counters.notes.quarantined).toBe(1);
        const files = await listVaultFiles(env.vault);
        expect(files.some((file) => file.includes(".."))).toBe(false);
        expect(files.some((file) => file.includes("polluted"))).toBe(false);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  });

  test("sahiplik önek karşılaştırması literal çalışır (_ ve % joker değil)", () => {
    const databaseId = "aaaa_bbbb%cc";
    expect(isAgzOwnedSourceKey(`agz:${databaseId}:p:n:1`, databaseId)).toBe(
      true,
    );
    expect(isAgzOwnedSourceKey("agz:aaaaxbbbb%cc:p:n:1", databaseId)).toBe(
      false,
    );
    expect(isAgzOwnedSourceKey("agz:aaaa_bbbbXcc:p:n:1", databaseId)).toBe(
      false,
    );
    expect(isAgzOwnedSourceKey("evt:aaaa_bbbb%cc:p:n:1", databaseId)).toBe(
      false,
    );
  });
});

describe("M07 rollback sonrası replay ve receipt bağı", () => {
  test("tombstoned hedef için commit replay sessiz duplicate başarı vermez", async () => {
    const dir = await freshDir("forge-m07-commit-tomb-");
    const fixturePath = join(dir, "agz.db");
    await buildAgzFixture(fixturePath, { profile: "clean" });
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(fixturePath);
      try {
        const plan = await planOf(env, source, mappings);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: fixturePath,
        });
        const spaceId = mappings[0]!.target.memorySpaceId;
        const document = plan.documents.find(
          (doc) =>
            doc.sourceNoteId === AGZ_FIXTURE_IDS.noteRule &&
            doc.sourceRevision === 1,
        )!;
        await env.service.archiveNote(env.owner, {
          spaceId,
          noteId: AGZ_FIXTURE_IDS.noteRule,
        });
        const recorded = await env.service.recordEvent(env.owner, {
          spaceId,
          sourceEventKey: agzIdempotencyKey(
            plan.manifest.source.databaseId,
            AGZ_FIXTURE_IDS.projectAlpha,
            AGZ_FIXTURE_IDS.noteRule,
            1,
          ),
          sourceKind: "migration",
          contentHash: document.sha256,
        });
        const error = await rejection(() =>
          env.commits.commit({
            identity: env.owner,
            spaceId,
            eventId: recorded.event.id,
            sourceKind: "migration",
            content: document.content,
            noteId: AGZ_FIXTURE_IDS.noteRule,
            baseRevision: 1,
          }),
        );
        expect(error.code).toBe("memory_note_deleted");
        expect(error.status).toBe(409);
        const note = await env.storage.db
          .selectFrom("memory_notes")
          .select(["deleted_at", "current_revision"])
          .where("space_id", "=", spaceId)
          .where("id", "=", AGZ_FIXTURE_IDS.noteRule)
          .executeTakeFirstOrThrow();
        expect(note.deleted_at).not.toBeNull();
        expect(note.current_revision).toBe(1);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  });

  test("rollback sonrası aynı stage replay'i partial/conflict olur, hiçbir not dirilmez", async () => {
    const dir = await freshDir("forge-m07-replay-");
    const fixturePath = join(dir, "agz.db");
    await buildAgzFixture(fixturePath, { profile: "clean" });
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(fixturePath);
      try {
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
        expect(rolled.counters.rolledBack).toBe(8);
        const notesBefore = Number(
          (
            await env.storage.db
              .selectFrom("memory_notes")
              .select((eb) => eb.fn.countAll<number>().as("count"))
              .executeTakeFirstOrThrow()
          ).count,
        );
        const revisionsBefore = Number(
          (
            await env.storage.db
              .selectFrom("memory_note_revisions")
              .select((eb) => eb.fn.countAll<number>().as("count"))
              .executeTakeFirstOrThrow()
          ).count,
        );
        const replay = await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: fixturePath,
        });
        expect(replay.status).not.toBe("already_applied");
        expect(replay.status).toBe("partial");
        expect(replay.counters.notes.duplicate).toBe(0);
        expect(replay.counters.notes.conflict).toBe(8);
        expect(
          Number(
            (
              await env.storage.db
                .selectFrom("memory_notes")
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .executeTakeFirstOrThrow()
            ).count,
          ),
        ).toBe(notesBefore);
        expect(
          Number(
            (
              await env.storage.db
                .selectFrom("memory_note_revisions")
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .executeTakeFirstOrThrow()
            ).count,
          ),
        ).toBe(revisionsBefore);
        const tombstoned = await env.storage.db
          .selectFrom("memory_notes")
          .select(["deleted_at"])
          .execute();
        expect(tombstoned.every((row) => row.deleted_at !== null)).toBe(true);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  });

  test("receipt-stage digest bağı kopuksa rollback reddedilir ve hiçbir not geri alınmaz", async () => {
    const dir = await freshDir("forge-m07-receipt-");
    const fixturePath = join(dir, "agz.db");
    await buildAgzFixture(fixturePath, { profile: "clean" });
    const env = await openEnv();
    try {
      const mappings = await bindMappings(env);
      const source = await sourceOf(fixturePath);
      try {
        const plan = await planOf(env, source, mappings);
        const staged = await stageAgzImport(plan, { vaultRoot: env.vault });
        await applyAgzImport({
          service: env.service,
          commits: env.commits,
          identity: env.owner,
          stageDir: staged.stageDir,
          sourcePath: fixturePath,
        });
        const receiptPath = join(staged.stageDir, "receipt.json");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
          manifestDigest: string;
          stageDigest: string;
        };
        await writeFile(
          receiptPath,
          JSON.stringify(
            { ...receipt, manifestDigest: "0".repeat(64) },
            null,
            2,
          ),
        );
        const error = await rejection(() =>
          rollbackAgzImport({
            service: env.service,
            identity: env.owner,
            stageDir: staged.stageDir,
          }),
        );
        expect(error.code).toBe("agz_stage_conflict");
        const rows = await env.storage.db
          .selectFrom("memory_notes")
          .select(["deleted_at"])
          .execute();
        expect(rows.every((row) => row.deleted_at === null)).toBe(true);
        expect(rows).toHaveLength(8);
      } finally {
        await source.close();
      }
    } finally {
      await env.storage.close();
    }
  });
});
