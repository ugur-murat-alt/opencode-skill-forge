/**
 * AGZ-Memory salt-okunur envanter/dry-run kabul testleri.
 *
 * Kaynak şema 11 fixture'ı `test/fixtures/agz/buildAgzFixture.ts` ile
 * üretilir. Testler canlı kullanıcı verisine, tokena veya gerçek DB yoluna
 * dokunmaz; yalnız geçici dizinlerdeki deterministik fixture dosyalarını
 * kullanır.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGZ_FIXTURE_IDS,
  buildAgzFixture,
  buildUnsupportedSchemaFixture,
  fileSnapshot,
} from "./fixtures/agz/buildAgzFixture.js";
import { noteContentHash } from "../src/memory/agz/hash.js";
import { openAgzSource, type AgzSource } from "../src/memory/agz/inventory.js";
import {
  AGZ_EXPECTED_SCHEMA_V11_FINGERPRINT,
  computeSchemaFingerprint,
} from "../src/memory/agz/schema-v11.js";
import { openReadOnlySqlite } from "../src/memory/agz/sqlite-driver.js";

const REPORT_NOW = 1_770_000_000_000;

const roots: string[] = [];
let root: string;
let fixturePath: string;

async function freshRoot(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  roots.push(created);
  return created;
}

async function openBaseFixture(): Promise<AgzSource> {
  return openAgzSource(fixturePath, { now: () => REPORT_NOW });
}

async function collectAll<Item>(
  scan: (page: { cursor?: string | null; limit?: number }) => {
    items: Item[];
    nextCursor: string | null;
  },
  limit: number,
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = scan({ cursor, limit });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
}

async function captureRejection<R>(run: () => Promise<R>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeAll(async () => {
  root = await freshRoot("forge-agz-");
  fixturePath = join(root, "agz-base.db");
  await buildAgzFixture(fixturePath);
});

afterAll(async () => {
  await Promise.all(
    roots.map((item) => rm(item, { recursive: true, force: true })),
  );
});

describe("AGZ schema 11 fixture", () => {
  test("parmak izi AGZ 0.5.2 sabitiyle aynıdır ve kimlik alanları tutarlıdır", async () => {
    const db = await openReadOnlySqlite(fixturePath);
    try {
      expect(computeSchemaFingerprint(db)).toBe(
        AGZ_EXPECTED_SCHEMA_V11_FINGERPRINT,
      );
      expect(
        db.get(
          `SELECT database_id, product_id, schema_version, hash_policy
             FROM agz_meta
            WHERE id = 1`,
        ),
      ).toEqual({
        database_id: AGZ_FIXTURE_IDS.databaseId,
        product_id: "agz-memory",
        schema_version: 11,
        hash_policy: "hash-tuple/2",
      });
      expect(db.get("SELECT version FROM schema_state")).toEqual({
        version: 11,
      });
    } finally {
      db.close();
    }
  });

  test("tekrar üretim byte düzeyinde deterministiktir", async () => {
    const secondRoot = await freshRoot("forge-agz-det-");
    const secondPath = join(secondRoot, "agz-base-2.db");
    await buildAgzFixture(secondPath);
    const first = await fileSnapshot(fixturePath);
    const second = await fileSnapshot(secondPath);
    expect(second.sha256).toBe(first.sha256);
    expect(second.sizeBytes).toBe(first.sizeBytes);
  });

  test("yaşam döngüsü, revision, pin, edge ve artık çeşitliliğini taşır", async () => {
    const db = await openReadOnlySqlite(fixturePath);
    try {
      expect(
        db.all(
          "SELECT status, COUNT(*) AS count FROM notes GROUP BY status ORDER BY status",
        ),
      ).toEqual([
        { status: "active", count: 6 },
        { status: "archived", count: 3 },
        { status: "superseded", count: 1 },
      ]);
      expect(
        db.get("SELECT COUNT(*) AS count FROM notes WHERE pinned = 1"),
      ).toEqual({ count: 2 });
      expect(db.get("SELECT COUNT(*) AS count FROM note_revisions")).toEqual({
        count: 13,
      });
      expect(
        db.all(
          "SELECT predicate, COUNT(*) AS count FROM note_edges GROUP BY predicate ORDER BY predicate",
        ),
      ).toEqual([
        { predicate: "ABOUT", count: 2 },
        { predicate: "DERIVED_FROM", count: 1 },
        { predicate: "PART_OF", count: 1 },
        { predicate: "PRECEDES", count: 1 },
        { predicate: "SUPERSEDES", count: 1 },
        { predicate: "SUPPORTS", count: 2 },
      ]);
      expect(db.get("SELECT COUNT(*) AS count FROM capture_events")).toEqual({
        count: 2,
      });
      expect(db.get("SELECT COUNT(*) AS count FROM index_outbox")).toEqual({
        count: 3,
      });
      expect(db.get("SELECT COUNT(*) AS count FROM note_provenance")).toEqual({
        count: 13,
      });
    } finally {
      db.close();
    }
  });
});

describe("AGZ hash politikası", () => {
  test("hash-tuple/2 değerleri AGZ 0.5.2 ile birebir aynıdır", () => {
    expect(
      noteContentHash(
        "decision",
        "Kimlik Eşleme Kuralı",
        "UUID tabanlı eşleme",
        "Proje UUID değişse de not UUID korunur.",
      ),
    ).toBe("8c71e6721c1d7031d35046ae0051cfe82dbefbb875b2786ff627a668b7882179");
    expect(
      noteContentHash(
        "fact",
        "Ünicode Başlık 🧠 — ğüşiöçİı",
        "Emoji ve Türkçe",
        "İçerik: \u0130stanbul, \u00e7ağrı, 🤝, e\u0301 (combining).",
      ),
    ).toBe("2114876fc9079bb1f82efe3ceeeac8e921346da444b6b2d9d68ed478192052e7");
    expect(noteContentHash("context", "", "", "")).toBe(
      "cc199689ffa814c37db9abd2d0b8ba40c4cda6f192776819bf4ac6999a0662a4",
    );
    expect(
      noteContentHash(
        "preference",
        "Präferenz: e2e",
        "özet",
        "satır1\nsatır2\ttab",
      ),
    ).toBe("3bf317f5280a04a85137bd7233dfa567c6e5486ef4945501cb247c2c5e0424bd");
  });
});

describe("salt-okunur kaynak erişimi", () => {
  test("sürücü salt-okunurdur, yazma denemesi SQLITE_READONLY ile reddedilir ve dosya değişmez", async () => {
    const before = await fileSnapshot(fixturePath);
    const db = await openReadOnlySqlite(fixturePath);
    try {
      expect(db.readonly).toBe(true);
      expect(["bun:sqlite", "better-sqlite3"]).toContain(db.driver);
      for (const sql of [
        "CREATE TABLE probe_write (x TEXT)",
        "PRAGMA user_version = 7",
        "INSERT INTO notes (id) VALUES ('probe')",
      ]) {
        let caught: unknown;
        try {
          db.exec(sql);
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({ code: "SQLITE_READONLY" });
      }
    } finally {
      db.close();
    }
    const after = await fileSnapshot(fixturePath);
    expect(after.sha256).toBe(before.sha256);
    expect(after.sizeBytes).toBe(before.sizeBytes);
    expect(await readdir(root)).toEqual(["agz-base.db"]);
  });

  test("envanter okuması kaynağı değiştirmez; verifyUnchanged ve close temizdir", async () => {
    const before = await fileSnapshot(fixturePath);
    const source = await openBaseFixture();
    try {
      const notes = await collectAll((page) => source.scanNotes(page), 3);
      expect(notes).toHaveLength(10);
      const report = source.buildDryRunReport();
      expect(report.source.file.sha256).toBe(before.sha256);
      await source.verifyUnchanged();
    } finally {
      await source.close();
    }
    const after = await fileSnapshot(fixturePath);
    expect(after.sha256).toBe(before.sha256);
    expect(await readdir(root)).toEqual(["agz-base.db"]);
  });

  test("WAL yan dosyası bulunan kopya dondurulmuş anlık görüntü olarak reddedilir", async () => {
    const copyRoot = await freshRoot("forge-agz-wal-");
    const copyPath = join(copyRoot, "copy.db");
    await copyFile(fixturePath, copyPath);
    await writeFile(`${copyPath}-wal`, "stale-wal-bytes");
    const before = await fileSnapshot(copyPath);
    const error = await captureRejection(() =>
      openAgzSource(copyPath, { now: () => REPORT_NOW }),
    );
    expect(error).toMatchObject({ code: "source_snapshot_not_frozen" });
    expect(
      (error as { details: Record<string, unknown> }).details,
    ).toMatchObject({ reason: "sidecar_present" });
    const after = await fileSnapshot(copyPath);
    expect(after.sha256).toBe(before.sha256);
    expect((await readdir(copyRoot)).sort()).toEqual([
      "copy.db",
      "copy.db-wal",
    ]);
  });

  test("WAL günlük modundaki kaynak açılmadan reddedilir ve yan dosya üretmez", async () => {
    const walRoot = await freshRoot("forge-agz-walmode-");
    const walPath = join(walRoot, "wal-mode.db");
    await buildAgzFixture(walPath, { freeze: false });
    const before = await fileSnapshot(walPath);
    const error = await captureRejection(() =>
      openAgzSource(walPath, { now: () => REPORT_NOW }),
    );
    expect(error).toMatchObject({ code: "source_snapshot_not_frozen" });
    expect(
      (error as { details: Record<string, unknown> }).details,
    ).toMatchObject({ reason: "wal_mode_source" });
    const after = await fileSnapshot(walPath);
    expect(after.sha256).toBe(before.sha256);
    expect(await readdir(walRoot)).toEqual(["wal-mode.db"]);
  });
});

describe("desteklenmeyen kaynak şema sürümü", () => {
  test("gelecek şema sürümü mutasyonsuz reddedilir", async () => {
    const futureRoot = await freshRoot("forge-agz-future-");
    const futurePath = join(futureRoot, "future.db");
    await buildUnsupportedSchemaFixture(futurePath, 12);
    const before = await fileSnapshot(futurePath);
    const error = await captureRejection(() => openAgzSource(futurePath));
    expect(error).toMatchObject({ code: "unsupported_source_schema" });
    expect(
      (error as { details: Record<string, unknown> }).details,
    ).toMatchObject({ foundSchemaVersion: 12, supportedSchemaVersion: 11 });
    const after = await fileSnapshot(futurePath);
    expect(after.sha256).toBe(before.sha256);
  });

  test("eski şema sürümü sürüm bilgisiyle reddedilir", async () => {
    const oldRoot = await freshRoot("forge-agz-old-");
    const oldPath = join(oldRoot, "old.db");
    await buildUnsupportedSchemaFixture(oldPath, 10);
    const error = await captureRejection(() => openAgzSource(oldPath));
    expect(error).toMatchObject({ code: "unsupported_source_schema" });
    expect(
      (error as { details: Record<string, unknown> }).details,
    ).toMatchObject({ foundSchemaVersion: 10, supportedSchemaVersion: 11 });
  });

  test("SQLite olmayan dosya mutasyonsuz reddedilir", async () => {
    const junkRoot = await freshRoot("forge-agz-junk-");
    const junkPath = join(junkRoot, "not-a-database.db");
    await writeFile(junkPath, "bu bir sqlite dosyası değil\n");
    const before = await fileSnapshot(junkPath);
    const error = await captureRejection(() => openAgzSource(junkPath));
    expect(error).toMatchObject({ code: "unsupported_source_schema" });
    const after = await fileSnapshot(junkPath);
    expect(after.sha256).toBe(before.sha256);
  });
});

describe("envanter sayımları ve cursor/batch taraması", () => {
  test("sayımlar fixture beklentisiyle birebir aynıdır", async () => {
    const source = await openBaseFixture();
    try {
      expect(source.counts()).toMatchObject({
        schemaVersion: 11,
        projects: 3,
        notes: 10,
        notesActive: 6,
        notesSuperseded: 1,
        notesArchived: 3,
        notesPinned: 2,
        revisions: 13,
        provenance: 13,
        edges: 8,
        edgesByPredicate: {
          SUPPORTS: 2,
          DERIVED_FROM: 1,
          PART_OF: 1,
          ABOUT: 2,
          PRECEDES: 1,
          SUPERSEDES: 1,
        },
        captureEvents: 2,
        captureEventStates: { materialized: 1, shadowed: 1 },
        captureCheckpoints: 1,
        projectBindings: 1,
        outbox: 3,
        outboxStates: { pending: 1, dead: 1, succeeded: 1 },
      });
    } finally {
      await source.close();
    }
  });

  test("cursor/batch taraması her öğeyi tam bir kez ve kararlı sırada verir", async () => {
    const source = await openBaseFixture();
    try {
      const notesAll = source.scanNotes({ limit: 1000 }).items;
      const notesPaged = await collectAll((page) => source.scanNotes(page), 2);
      expect(notesPaged.map((note) => note.id)).toEqual(
        notesAll.map((note) => note.id),
      );
      expect(new Set(notesPaged.map((note) => note.id)).size).toBe(
        notesPaged.length,
      );

      const revisionsAll = source.scanRevisions({ limit: 1000 }).items;
      const revisionsPaged = await collectAll(
        (page) => source.scanRevisions(page),
        3,
      );
      expect(
        revisionsPaged.map(
          (revision) => `${revision.noteId}:${revision.revision}`,
        ),
      ).toEqual(
        revisionsAll.map(
          (revision) => `${revision.noteId}:${revision.revision}`,
        ),
      );

      const edgesAll = source.scanEdges({ limit: 1000 }).items;
      const edgesPaged = await collectAll((page) => source.scanEdges(page), 1);
      expect(edgesPaged.map((edge) => edge.id)).toEqual(
        edgesAll.map((edge) => edge.id),
      );

      const provenanceAll = source.scanProvenance({ limit: 1000 }).items;
      const provenancePaged = await collectAll(
        (page) => source.scanProvenance(page),
        2,
      );
      expect(provenancePaged.map((item) => item.id)).toEqual(
        provenanceAll.map((item) => item.id),
      );

      const projectsAll = source.scanProjects({ limit: 1000 }).items;
      const projectsPaged = await collectAll(
        (page) => source.scanProjects(page),
        1,
      );
      expect(projectsPaged.map((project) => project.id)).toEqual(
        projectsAll.map((project) => project.id),
      );

      expect(source.scanNotes({ limit: 2 }).nextCursor).not.toBeNull();
      expect(source.scanNotes({ limit: 1000 }).nextCursor).toBeNull();
    } finally {
      await source.close();
    }
  });

  test("bozuk veya yanlış türde cursor reddedilir", async () => {
    const source = await openBaseFixture();
    try {
      const firstPage = source.scanNotes({ limit: 2 });
      expect(firstPage.nextCursor).not.toBeNull();
      let caught: unknown;
      try {
        source.scanEdges({ cursor: firstPage.nextCursor });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "invalid_cursor" });

      caught = undefined;
      try {
        source.scanNotes({ cursor: "!!bozuk!!" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "invalid_cursor" });
    } finally {
      await source.close();
    }
  });
});

describe("dry-run raporu", () => {
  test("kararlı sayım, digest ve kaynak kimliği üretir; gerçek değişiklik yapmaz", async () => {
    const before = await fileSnapshot(fixturePath);
    const first = await openBaseFixture();
    const firstReport = first.buildDryRunReport();
    await first.close();
    const second = await openBaseFixture();
    const secondReport = second.buildDryRunReport();
    await second.close();

    expect(firstReport.kind).toBe("agz-memory-dry-run");
    expect(firstReport.reportVersion).toBe(1);
    expect(firstReport.dryRun).toBe(true);
    expect(firstReport.generatedAt).toBe(REPORT_NOW);
    expect(firstReport.digest).toBe(secondReport.digest);
    expect(firstReport.counts).toEqual(secondReport.counts);
    expect(firstReport.source.schemaFingerprint).toBe(
      AGZ_EXPECTED_SCHEMA_V11_FINGERPRINT,
    );
    expect(firstReport.source.file.sha256).toBe(before.sha256);
    expect(firstReport.plan.projects).toHaveLength(3);
    expect(
      firstReport.plan.projects.map((project) => project.noteCount).sort(),
    ).toEqual([1, 2, 7]);
    expect(firstReport.plan.totals.notes).toBe(10);

    const after = await fileSnapshot(fixturePath);
    expect(after.sha256).toBe(before.sha256);
  });

  test("bozuk referansları, eksik provenance'ı ve hash uyuşmazlıklarını raporlar", async () => {
    const source = await openBaseFixture();
    try {
      const report = source.buildDryRunReport();
      const codes = new Set(report.issues.map((issue) => issue.code));
      for (const expected of [
        "edge_missing_endpoint",
        "edge_cross_project",
        "supersedes_missing",
        "provenance_missing_note",
        "revision_missing_provenance",
        "revision_gap",
        "note_content_hash_mismatch",
        "revision_content_hash_mismatch",
        "note_without_provenance",
      ]) {
        expect(codes).toContain(expected);
      }
      expect(report.decision.status).toBe("blocked");
      expect(report.decision.blockingIssues).toBe(8);
      expect(report.decision.warningIssues).toBe(1);
      expect(
        report.issues.find(
          (issue) => issue.code === "note_content_hash_mismatch",
        ),
      ).toMatchObject({
        noteId: AGZ_FIXTURE_IDS.noteOrphan,
        severity: "blocking",
      });

      const orphan = source
        .scanNotes({ limit: 1000 })
        .items.find((note) => note.id === AGZ_FIXTURE_IDS.noteOrphan);
      expect(orphan?.contentHashMatches).toBe(false);
      const unicode = source
        .scanNotes({ limit: 1000 })
        .items.find((note) => note.id === AGZ_FIXTURE_IDS.noteUnicode);
      expect(unicode?.contentHashMatches).toBe(true);
      expect(unicode?.contentHash).toBe(
        "2114876fc9079bb1f82efe3ceeeac8e921346da444b6b2d9d68ed478192052e7",
      );
      expect(unicode?.recomputedContentHash).toBe(unicode?.contentHash);
      expect(unicode?.title).toBe("Ünicode Başlık 🧠 — ğüşiöçİı");
    } finally {
      await source.close();
    }
  });

  test("capture_events, outbox ve binding artıkları aktarım dışı olarak raporlanır", async () => {
    const source = await openBaseFixture();
    try {
      const report = source.buildDryRunReport();
      const exclusions = new Map(
        report.exclusions.map((exclusion) => [exclusion.table, exclusion]),
      );
      expect(exclusions.get("capture_events")).toMatchObject({ count: 2 });
      expect(exclusions.get("index_outbox")).toMatchObject({ count: 3 });
      expect(exclusions.get("project_bindings")).toMatchObject({ count: 1 });
      expect(exclusions.get("capture_checkpoints")).toMatchObject({
        count: 1,
      });
      expect(report.counts.captureEventStates).toMatchObject({
        materialized: 1,
        shadowed: 1,
      });
      expect(report.counts.outboxStates).toMatchObject({
        pending: 1,
        dead: 1,
        succeeded: 1,
      });
      const captureEventExclusion = exclusions.get("capture_events");
      expect(captureEventExclusion?.reason).toContain("replay");
      const outboxExclusion = exclusions.get("index_outbox");
      expect(outboxExclusion?.reason).toContain("replay");
    } finally {
      await source.close();
    }
  });
});

describe("eşleme çakışma senaryoları", () => {
  test("aynı ad farklı UUID, aynı başlık farklı UUID ve aynı not UUID farklı DB ayrı kalır", async () => {
    const twinRoot = await freshRoot("forge-agz-twin-");
    const twinPath = join(twinRoot, "agz-twin.db");
    await buildAgzFixture(twinPath, { variant: "twin" });
    const base = await openBaseFixture();
    const twin = await openAgzSource(twinPath, { now: () => REPORT_NOW });
    try {
      const baseAlpha = base
        .scanProjects({ limit: 100 })
        .items.find((project) => project.name === "Proje Alfa");
      const twinAlpha = twin
        .scanProjects({ limit: 100 })
        .items.find((project) => project.name === "Proje Alfa");
      expect(baseAlpha?.normalizedName).toBe(twinAlpha?.normalizedName);
      expect(baseAlpha?.id).not.toBe(twinAlpha?.id);

      const baseNotes = base.scanNotes({ limit: 1000 }).items;
      const twinNotes = twin.scanNotes({ limit: 1000 }).items;
      const baseRule = baseNotes.find(
        (note) => note.id === AGZ_FIXTURE_IDS.noteRule,
      );
      const baseDuplicate = baseNotes.find(
        (note) => note.id === AGZ_FIXTURE_IDS.noteDuplicateTitle,
      );
      expect(baseDuplicate?.title).toBe(baseRule?.title);
      expect(baseDuplicate?.id).not.toBe(baseRule?.id);

      const twinRule = twinNotes.find(
        (note) => note.id === AGZ_FIXTURE_IDS.noteRule,
      );
      expect(twinRule?.projectId).toBe(twinAlpha?.id);
      expect(twinRule?.contentHash).not.toBe(baseRule?.contentHash);

      const baseReport = base.buildDryRunReport();
      const twinReport = twin.buildDryRunReport();
      expect(baseReport.source.databaseId).toBe(AGZ_FIXTURE_IDS.databaseId);
      expect(twinReport.source.databaseId).toBe(AGZ_FIXTURE_IDS.twinDatabaseId);
      expect(baseReport.digest).not.toBe(twinReport.digest);
    } finally {
      await base.close();
      await twin.close();
    }
  });
});
