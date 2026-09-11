import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { vaultRoot } from "../src/memory/paths.js";
import { openAgzSource } from "../src/memory/agz/inventory.js";
import {
  agzDocumentRelativePath,
  ensureAgzTargetSpace,
  isSafeAgzNoteId,
  planAgzImport,
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

/**
 * Bağımsız M07 düzeltme doğrulaması (509f92c, 622d560).
 *
 * - Güvensiz not kimliği yola gömülmez; stage kapısı yazımdan önce reddeder.
 * - Sahiplik tespiti LIKE değil literal önek: `%` içeren databaseId başka
 *   kaynağın notunu sahiplenemez, kimlik remap edilir.
 * - Rollback, receipt'in manifest/stage digest bağını doğrular; kopuklukta
 *   hiçbir notu arşivlemez.
 */

const FIXED_NOW = 1_775_000_000_000;

async function freshDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function openEnv() {
  const root = await freshDir("forge-m07-guards-ind-");
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
  const space = await service.ensureSpace(owner, { type: "personal" });
  const mappings: AgzProjectMapping[] = [
    await ensureAgzTargetSpace({
      service,
      identity: owner,
      sourceProjectId: AGZ_FIXTURE_IDS.projectAlpha,
      sourceName: "Alfa",
      normalizedName: "alfa",
      kind: "personal",
    }),
    await ensureAgzTargetSpace({
      service,
      identity: owner,
      sourceProjectId: AGZ_FIXTURE_IDS.projectBeta,
      sourceName: "Beta",
      normalizedName: "beta",
      kind: "organization",
      organizationName: "Beta Org",
    }),
    await ensureAgzTargetSpace({
      service,
      identity: owner,
      sourceProjectId: AGZ_FIXTURE_IDS.projectArchive,
      sourceName: "Arşiv",
      normalizedName: "arsiv",
      kind: "organization",
      organizationName: "Arşiv Org",
    }),
  ];
  return {
    root,
    storage,
    owner,
    service,
    commits,
    spaceId: space.id,
    mappings,
    close: async () => {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("güvensiz not kimliği yola gömülmez ve stage kapısı yazımsız reddeder", async () => {
  expect(isSafeAgzNoteId("note-1_AB")).toBe(true);
  for (const unsafe of [
    "../../evil",
    "a/b",
    "a\\b",
    "..",
    "",
    "a".repeat(65),
    "-leading",
  ])
    expect(isSafeAgzNoteId(unsafe), unsafe).toBe(false);
  const relative = agzDocumentRelativePath("../../evil", 2, "a".repeat(64));
  expect(relative).not.toContain("..");
  expect(relative).toMatch(/^documents\/x-[0-9a-f]{32}\/2-a+\.md$/);

  const env = await openEnv();
  try {
    const content = "---\nformat_version: 1\n---\nGövde.\n";
    const documentSha = (await import("node:crypto"))
      .createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const hostileId = "../../../../polluted";
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
          databaseId: "hostile-db",
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
              memorySpaceId: env.spaceId,
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
    let caught: unknown;
    try {
      await stageAgzImport(
        plan as unknown as Parameters<typeof stageAgzImport>[0],
        { vaultRoot: vaultRoot(env.root) },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toMatch(
      /invalid_agz_manifest|agz_hostile_note_id|invalid_agz_mapping|agz_stage_integrity/,
    );
    const walk = async (dir: string, prefix: string): Promise<string[]> => {
      const out: string[] = [];
      const entries = await (
        await import("node:fs/promises")
      ).readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory())
          out.push(...(await walk(join(dir, entry.name), rel)));
        else out.push(rel);
      }
      return out;
    };
    const files = await walk(vaultRoot(env.root), "").catch(() => []);
    expect(files.some((file) => file.includes("polluted"))).toBe(false);
  } finally {
    await env.close();
  }
}, 60000);

test("databaseId '%' başka kaynağın notunu sahiplenemez; kimlik remap edilir", async () => {
  const env = await openEnv();
  const baseDir = await freshDir("forge-m07-guards-base-");
  const hostileDir = await freshDir("forge-m07-guards-like-");
  const basePath = join(baseDir, "agz.db");
  const likePath = join(hostileDir, "agz.db");
  try {
    // Temel kaynak hedef alana aktarılır.
    await buildAgzFixture(basePath, { profile: "clean" });
    const baseSource = await openAgzSource(basePath, { now: () => FIXED_NOW });
    const basePlan = await planAgzImport({
      source: baseSource,
      targetDb: env.storage.db,
      mappings: env.mappings,
      now: () => FIXED_NOW,
    });
    const baseStage = await stageAgzImport(basePlan, {
      vaultRoot: vaultRoot(env.root),
    });
    await applyAgzImport({
      service: env.service,
      commits: env.commits,
      identity: env.owner,
      stageDir: baseStage.stageDir,
      sourcePath: basePath,
    });
    await baseSource.close();

    // `%` içeren databaseId'li ikinci kaynak aynı alanı hedefler.
    await buildAgzFixture(likePath, {
      profile: "clean",
      databaseId: "%",
    });
    const likeSource = await openAgzSource(likePath, { now: () => FIXED_NOW });
    try {
      const likePlan = await planAgzImport({
        source: likeSource,
        targetDb: env.storage.db,
        mappings: env.mappings,
        now: () => FIXED_NOW,
      });
      const rule = likePlan.manifest.notes.find(
        (note) => note.sourceNoteId === AGZ_FIXTURE_IDS.noteRule,
      )!;
      // LIKE `agz:%:%` tüm olaylarla eşleşirdi; literal önek eşleşmez.
      expect(rule.idDecision).toBe("remapped");
      expect(rule.targetNoteId).not.toBe(AGZ_FIXTURE_IDS.noteRule);
    } finally {
      await likeSource.close();
    }
  } finally {
    await env.close();
    await rm(baseDir, { recursive: true, force: true });
    await rm(hostileDir, { recursive: true, force: true });
  }
}, 90000);

test("rollback receipt digest bağı kopuksa hiçbir notu arşivlemez", async () => {
  const env = await openEnv();
  const dir = await freshDir("forge-m07-guards-rollback-");
  const fixturePath = join(dir, "agz.db");
  try {
    await buildAgzFixture(fixturePath, { profile: "clean" });
    const source = await openAgzSource(fixturePath, { now: () => FIXED_NOW });
    const plan = await planAgzImport({
      source,
      targetDb: env.storage.db,
      mappings: env.mappings,
      now: () => FIXED_NOW,
    });
    const stage = await stageAgzImport(plan, {
      vaultRoot: vaultRoot(env.root),
    });
    await applyAgzImport({
      service: env.service,
      commits: env.commits,
      identity: env.owner,
      stageDir: stage.stageDir,
      sourcePath: fixturePath,
    });
    // Receipt başka bir manifest/stage'e ait gibi gösterilir.
    const receiptPath = join(stage.stageDir, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, manifestDigest: "0".repeat(64) }),
    );
    let caught: unknown;
    try {
      await rollbackAgzImport({
        service: env.service,
        identity: env.owner,
        stageDir: stage.stageDir,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("agz_stage_conflict");
    const archived = await env.storage.db
      .selectFrom("memory_notes")
      .select(["id", "deleted_at"])
      .execute();
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.every((note) => note.deleted_at === null)).toBe(true);
    await source.close();
  } finally {
    await env.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 90000);
