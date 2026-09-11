/**
 * Deterministik AGZ-Memory schema v11 fixture üreticisi.
 *
 * Fixture, AGZ-Memory 0.5.2 (commit 80096ab) şemasını birebir DDL ile
 * kurar; `agz_meta.schema_fingerprint` gerçek parmak izi hesabıyla
 * doğrulanır. Amaç negatif senaryoları da içeren sabit bir kaynak anlık
 * görüntüsüdür:
 *
 * - üç proje, iki proje adı aynı kalıp UUID değişen "twin" varyantı,
 * - active/superseded/archived notlar, çoklu revision, pin, provenance,
 * - altı AGZ edge türü ve bozuk/çapraz proje referansları,
 * - aynı başlıklı farklı UUID'li notlar ve Unicode başlık,
 * - capture_events, capture_checkpoints, project_bindings ve index_outbox
 *   artıkları (bunlar hedefe not olarak aktarılmaz).
 *
 * Fixture yalnız test amaçlıdır; üretim kodundan bu modüle import edilmez.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { noteContentHash } from "../../../src/memory/agz/hash.js";
import { computeSchemaFingerprint } from "../../../src/memory/agz/schema-v11.js";
import {
  openWritableSqlite,
  type WritableSqliteConnection,
} from "../../../src/memory/agz/sqlite-driver.js";
import { FTS_V9, SCHEMA_V11_TABLES } from "./schema-v11-ddl.js";

export const AGZ_FIXTURE_APPLICATION_ID = 0x41475a4d;
export const AGZ_FIXTURE_T0 = 1_760_000_000_000;

export const AGZ_FIXTURE_IDS = {
  databaseId: "e0000000-0000-4000-8000-000000000001",
  twinDatabaseId: "e0000000-0000-4000-8000-000000000002",
  projectAlpha: "a0000000-0000-4000-8000-000000000101",
  projectAlphaTwin: "a0000000-0000-4000-8000-000000000201",
  projectBeta: "a0000000-0000-4000-8000-000000000102",
  projectArchive: "a0000000-0000-4000-8000-000000000103",
  noteRule: "b0000000-0000-4000-8000-000000000001",
  noteUnicode: "b0000000-0000-4000-8000-000000000002",
  noteSupersededProcedure: "b0000000-0000-4000-8000-000000000003",
  noteCurrentProcedure: "b0000000-0000-4000-8000-000000000004",
  noteArchivedResearch: "b0000000-0000-4000-8000-000000000005",
  noteOrphan: "b0000000-0000-4000-8000-000000000006",
  notePreference: "b0000000-0000-4000-8000-000000000007",
  noteTask: "b0000000-0000-4000-8000-000000000008",
  noteArchivedGap: "b0000000-0000-4000-8000-000000000009",
  noteDuplicateTitle: "b0000000-0000-4000-8000-000000000010",
  missingNote: "b0000000-0000-4000-8000-0000000000ff",
  missingProvenance: "c0000000-0000-4000-8000-0000000000ff",
} as const;

export const AGZ_FIXTURE_PROVENANCE = {
  rule: "c0000000-0000-4000-8000-000000000001",
  unicode: "c0000000-0000-4000-8000-000000000002",
  supersededProcedure: "c0000000-0000-4000-8000-000000000003",
  procedureRevision1: "c0000000-0000-4000-8000-000000000004",
  procedureRevision2: "c0000000-0000-4000-8000-000000000005",
  archivedResearch: "c0000000-0000-4000-8000-000000000006",
  duplicateTitle: "c0000000-0000-4000-8000-000000000007",
  preference: "c0000000-0000-4000-8000-000000000008",
  taskRevision1: "c0000000-0000-4000-8000-000000000009",
  taskRevision2: "c0000000-0000-4000-8000-00000000000a",
  taskRevision3: "c0000000-0000-4000-8000-00000000000b",
  archivedGap: "c0000000-0000-4000-8000-00000000000c",
} as const;

export const AGZ_FIXTURE_EDGES = {
  supports: "d0000000-0000-4000-8000-000000000001",
  derivedFrom: "d0000000-0000-4000-8000-000000000002",
  partOf: "d0000000-0000-4000-8000-000000000003",
  about: "d0000000-0000-4000-8000-000000000004",
  precedes: "d0000000-0000-4000-8000-000000000005",
  supersedes: "d0000000-0000-4000-8000-000000000006",
  missingEndpoint: "d0000000-0000-4000-8000-000000000007",
  crossProject: "d0000000-0000-4000-8000-000000000008",
} as const;

export const AGZ_FIXTURE_BINDING_KEY = "1".repeat(64);

export interface BuildAgzFixtureOptions {
  /** "twin": aynı proje adı farklı UUID + aynı not UUID farklı içerik. */
  variant?: "base" | "twin";
  databaseId?: string;
  /** false: WAL günlük modunda bırakır (dondurulmamış kaynak testi). */
  freeze?: boolean;
  /**
   * "negative" (varsayılan): bozuk referans/hash/revision senaryoları dahil.
   * "clean": yalnız sağlam not/edge/provenance — kayıpsız apply yolu testi.
   */
  profile?: "negative" | "clean";
}

export interface BuiltAgzFixture {
  path: string;
  databaseId: string;
  schemaFingerprint: string;
  fileSha256: string;
  fileSizeBytes: number;
}

export interface UnsupportedSchemaFixture {
  path: string;
  schemaVersion: number;
  fileSha256: string;
}

interface NoteSpec {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  sizeClass: "inline" | "indexed";
  pinned: boolean;
  status: "active" | "superseded" | "archived";
  supersedesId: string | null;
  currentRevision: number;
  subjectKey: string | null;
  contentHash?: string;
}

interface RevisionSpec {
  projectId: string;
  noteId: string;
  revision: number;
  kind: string;
  title: string;
  summary: string;
  content: string;
  sizeClass: string;
  pinned: boolean;
  status: string;
  supersedesId: string | null;
  subjectKey: string | null;
  contentHash?: string;
  provenanceId: string;
}

interface ProvenanceSpec {
  id: string;
  projectId: string;
  noteId: string;
  sourceType: string;
  captureEventId: string | null;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  sourceOrdinal: number | null;
  sourceToolCallId: string | null;
  redactionVersion: string | null;
  extractorVersion: string | null;
  confidence: number | null;
}

interface EdgeSpec {
  id: string;
  projectId: string;
  sourceId: string;
  targetId: string;
  predicate: string;
}

const BASE_ALPHA_RULE_SUMMARY = "UUID tabanlı eşleme";
const BASE_ALPHA_RULE_CONTENT =
  "Proje UUID değişse de not UUID korunur; eşleme ad üzerinden yapılmaz.";
const TWIN_ALPHA_RULE_SUMMARY = "Twin veritabanı eşleme notu";
const TWIN_ALPHA_RULE_CONTENT =
  "Aynı not UUID'si farklı kaynak veritabanında farklı içerik taşır.";

export async function buildAgzFixture(
  path: string,
  options: BuildAgzFixtureOptions = {},
): Promise<BuiltAgzFixture> {
  const variant = options.variant ?? "base";
  const negative = (options.profile ?? "negative") === "negative";
  const databaseId =
    options.databaseId ??
    (variant === "twin"
      ? AGZ_FIXTURE_IDS.twinDatabaseId
      : AGZ_FIXTURE_IDS.databaseId);
  const alpha =
    variant === "twin"
      ? AGZ_FIXTURE_IDS.projectAlphaTwin
      : AGZ_FIXTURE_IDS.projectAlpha;
  const alphaRuleSummary =
    variant === "twin" ? TWIN_ALPHA_RULE_SUMMARY : BASE_ALPHA_RULE_SUMMARY;
  const alphaRuleContent =
    variant === "twin" ? TWIN_ALPHA_RULE_CONTENT : BASE_ALPHA_RULE_CONTENT;

  await mkdir(dirname(path), { recursive: true });
  const db = await openWritableSqlite(path);
  let fingerprint = "";
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`PRAGMA application_id = ${1095195213}`);
    db.exec(SCHEMA_V11_TABLES);
    db.exec(FTS_V9);
    db.run("INSERT INTO schema_state (version) VALUES (11)");
    fingerprint = computeSchemaFingerprint(db);
    db.run(
      `INSERT INTO agz_meta
         (id, database_id, product_id, schema_version, schema_fingerprint, hash_policy, created_at)
       VALUES (1, ?, 'agz-memory', 11, ?, 'hash-tuple/2', ?)`,
      [databaseId, fingerprint, t(0)],
    );

    insertProjects(db, alpha);
    insertNotes(db, alpha, alphaRuleSummary, alphaRuleContent, negative);
    insertProvenance(db, alpha, negative);
    insertEdges(db, alpha, negative);
    insertBindingsAndCapture(db, alpha);
    insertOutbox(db, alpha);

    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (options.freeze ?? true) {
      db.exec("PRAGMA journal_mode=DELETE");
    }
  } finally {
    db.close();
  }

  if (!(options.freeze ?? true)) {
    // WAL başlığını korur ama yan dosyaları kaldırır: "WAL modunda
    // kopyalanmış, günlüğü alınmamış dosya" senaryosu. Envanter bunu
    // başlıktan yakalayıp açmadan reddetmelidir.
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }

  const snapshot = await fileSnapshot(path);
  return {
    path,
    databaseId,
    schemaFingerprint: fingerprint,
    fileSha256: snapshot.sha256,
    fileSizeBytes: snapshot.sizeBytes,
  };
}

export async function buildUnsupportedSchemaFixture(
  path: string,
  schemaVersion: number,
): Promise<UnsupportedSchemaFixture> {
  await mkdir(dirname(path), { recursive: true });
  const db = await openWritableSqlite(path);
  try {
    db.exec("PRAGMA application_id = 0");
    db.exec(`
      CREATE TABLE schema_state (version INTEGER PRIMARY KEY);
      CREATE TABLE agz_meta (
        id INTEGER PRIMARY KEY,
        database_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        schema_fingerprint TEXT NOT NULL,
        hash_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        size_class TEXT NOT NULL,
        pinned INTEGER NOT NULL,
        status TEXT NOT NULL,
        supersedes_id TEXT,
        current_revision INTEGER NOT NULL,
        subject_key TEXT,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.run("INSERT INTO schema_state (version) VALUES (?)", [schemaVersion]);
    db.run(
      `INSERT INTO agz_meta
         (id, database_id, product_id, schema_version, schema_fingerprint, hash_policy, created_at)
       VALUES (1, ?, 'agz-memory', ?, ?, 'hash-tuple/3', ?)`,
      [
        AGZ_FIXTURE_IDS.databaseId,
        schemaVersion,
        "a".repeat(64),
        AGZ_FIXTURE_T0,
      ],
    );
    db.run(
      `INSERT INTO projects (id, name, normalized_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        AGZ_FIXTURE_IDS.projectAlpha,
        "Gelecek Proje",
        "gelecek proje",
        AGZ_FIXTURE_T0,
        AGZ_FIXTURE_T0,
      ],
    );
    db.run(
      `INSERT INTO notes
         (id, project_id, kind, title, summary, content, size_class, pinned, status,
          supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
       VALUES (?, ?, 'fact', ?, '', '', 'inline', 0, 'active', NULL, 1, NULL, ?, ?, ?)`,
      [
        AGZ_FIXTURE_IDS.noteRule,
        AGZ_FIXTURE_IDS.projectAlpha,
        "Gelecek şema notu",
        "b".repeat(64),
        AGZ_FIXTURE_T0,
        AGZ_FIXTURE_T0,
      ],
    );
  } finally {
    db.close();
  }
  const snapshot = await fileSnapshot(path);
  return { path, schemaVersion, fileSha256: snapshot.sha256 };
}

export async function fileSnapshot(
  path: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const bytes = await readFile(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function insertProjects(db: WritableSqliteConnection, alpha: string): void {
  db.run(
    `INSERT INTO projects (id, name, normalized_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [alpha, "Proje Alfa", "proje alfa", t(1), t(1)],
  );
  db.run(
    `INSERT INTO projects (id, name, normalized_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [AGZ_FIXTURE_IDS.projectBeta, "Proje Beta", "proje beta", t(2), t(2)],
  );
  db.run(
    `INSERT INTO projects (id, name, normalized_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      AGZ_FIXTURE_IDS.projectArchive,
      "Arşiv Projesi",
      "arsiv projesi",
      t(3),
      t(3),
    ],
  );
}

function insertNotes(
  db: WritableSqliteConnection,
  alpha: string,
  alphaRuleSummary: string,
  alphaRuleContent: string,
  negative: boolean,
): void {
  const notes: NoteSpec[] = [
    {
      id: AGZ_FIXTURE_IDS.noteRule,
      projectId: alpha,
      kind: "decision",
      title: "Kimlik Eşleme Kuralı",
      summary: alphaRuleSummary,
      content: alphaRuleContent,
      sizeClass: "inline",
      pinned: true,
      status: "active",
      supersedesId: null,
      currentRevision: 1,
      subjectKey: "kimlik eşleme kuralı",
    },
    {
      id: AGZ_FIXTURE_IDS.noteUnicode,
      projectId: alpha,
      kind: "fact",
      title: "Ünicode Başlık 🧠 — ğüşiöçİı",
      summary: "Emoji ve Türkçe",
      content:
        "İçerik: \u0130stanbul, \u00e7ağrı, 🤝, e\u0301 (combining).",
      sizeClass: "inline",
      pinned: false,
      status: "active",
      supersedesId: null,
      currentRevision: 1,
      subjectKey: "unicode başlık",
    },
    {
      id: AGZ_FIXTURE_IDS.noteSupersededProcedure,
      projectId: alpha,
      kind: "procedure",
      title: "Eski Dağıtım Prosedürü",
      summary: "Artık geçersiz dağıtım adımları",
      content: "Eski adımlar: elle kopyala, servisi yeniden başlat.",
      sizeClass: "inline",
      pinned: false,
      status: "superseded",
      supersedesId: null,
      currentRevision: 1,
      subjectKey: "dağıtım prosedürü",
    },
    {
      id: AGZ_FIXTURE_IDS.noteCurrentProcedure,
      projectId: alpha,
      kind: "procedure",
      title: "Yeni Dağıtım Prosedürü",
      summary: "Geçerli dağıtım adımları",
      content: "Geçerli adımlar: önce test, sonra staging, sonra yayın.",
      sizeClass: "inline",
      pinned: false,
      status: "active",
      supersedesId: AGZ_FIXTURE_IDS.noteSupersededProcedure,
      currentRevision: 2,
      subjectKey: "dağıtım prosedürü",
    },
    {
      id: AGZ_FIXTURE_IDS.noteArchivedResearch,
      projectId: alpha,
      kind: "research",
      title: "Eski Araştırma Notu",
      summary: "Arşivlenmiş araştırma",
      content: "Arşiv nedeni: karar başka bir notta toplandı.",
      sizeClass: "indexed",
      pinned: false,
      status: "archived",
      supersedesId: null,
      currentRevision: 1,
      subjectKey: null,
    },
    {
      id: AGZ_FIXTURE_IDS.noteOrphan,
      projectId: alpha,
      kind: "context",
      title: "Yetim Kaynak Notu",
      summary: "Provenance kaydı olmayan not",
      content: "Bu notun provenance kaydı yok ve başlık hash'i bozulmuş.",
      sizeClass: "inline",
      pinned: false,
      status: "active",
      supersedesId: AGZ_FIXTURE_IDS.missingNote,
      currentRevision: 1,
      subjectKey: null,
      contentHash: "0".repeat(64),
    },
    {
      id: AGZ_FIXTURE_IDS.noteDuplicateTitle,
      projectId: alpha,
      kind: "decision",
      title: "Kimlik Eşleme Kuralı",
      summary: "Aynı başlıklı, farklı UUID'li arşiv notu",
      content: "Aynı başlık farklı UUID taşır; başlık kimlik değildir.",
      sizeClass: "inline",
      pinned: false,
      status: "archived",
      supersedesId: null,
      currentRevision: 1,
      subjectKey: null,
    },
    {
      id: AGZ_FIXTURE_IDS.notePreference,
      projectId: AGZ_FIXTURE_IDS.projectBeta,
      kind: "preference",
      title: "Tercih: Türkçe Yanıt",
      summary: "Kullanıcı Türkçe yanıt ister",
      content: "Yanıtlar Türkçe ve ölçülü olmalı.",
      sizeClass: "inline",
      pinned: true,
      status: "active",
      supersedesId: null,
      currentRevision: 1,
      subjectKey: "türkçe yanıt",
    },
    {
      id: AGZ_FIXTURE_IDS.noteTask,
      projectId: AGZ_FIXTURE_IDS.projectBeta,
      kind: "task",
      title: "Geçiş Görevi",
      summary: "AGZ geçiş hazırlığı",
      content: "Geçiş görevi: envanter, eşleme, dry-run ve rollback planı.",
      sizeClass: "inline",
      pinned: false,
      status: "active",
      supersedesId: null,
      currentRevision: 3,
      subjectKey: "geçiş görevi",
    },
    {
      id: AGZ_FIXTURE_IDS.noteArchivedGap,
      projectId: AGZ_FIXTURE_IDS.projectArchive,
      kind: "research",
      title: "Arşivlenmiş Araştırma",
      summary: "Revision boşluğu olan arşiv notu",
      content: "current_revision 2 der ama yalnız revision 1 vardır.",
      sizeClass: "inline",
      pinned: false,
      status: "archived",
      supersedesId: null,
      currentRevision: 2,
      subjectKey: null,
    },
  ];

  for (const note of notes) {
    if (!negative && isNegativeNote(note.id)) continue;
    const contentHash =
      note.contentHash ??
      noteContentHash(note.kind, note.title, note.summary, note.content);
    db.run(
      `INSERT INTO notes
         (id, project_id, kind, title, summary, content, size_class, pinned, status,
          supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        note.id,
        note.projectId,
        note.kind,
        note.title,
        note.summary,
        note.content,
        note.sizeClass,
        note.pinned,
        note.status,
        note.supersedesId,
        note.currentRevision,
        note.subjectKey,
        contentHash,
        t(10),
        t(10 + note.currentRevision),
      ],
    );
  }

  insertRevisions(db, negative);
}

function isNegativeNote(noteId: string): boolean {
  return (
    noteId === AGZ_FIXTURE_IDS.noteOrphan ||
    noteId === AGZ_FIXTURE_IDS.noteArchivedGap
  );
}

function insertRevisions(
  db: WritableSqliteConnection,
  negative: boolean,
): void {
  const notes = db.all<{
    id: string;
    project_id: string;
    kind: string;
    title: string;
    summary: string;
    content: string;
    size_class: string;
    pinned: number;
    status: string;
    supersedes_id: string | null;
    current_revision: number;
    subject_key: string | null;
    content_hash: string;
  }>("SELECT * FROM notes ORDER BY project_id, id");

  const provenanceFor = (noteId: string, revision: number): string => {
    if (noteId === AGZ_FIXTURE_IDS.noteCurrentProcedure) {
      return revision === 1
        ? AGZ_FIXTURE_PROVENANCE.procedureRevision1
        : AGZ_FIXTURE_PROVENANCE.procedureRevision2;
    }
    if (noteId === AGZ_FIXTURE_IDS.noteTask) {
      return revision === 1
        ? AGZ_FIXTURE_PROVENANCE.taskRevision1
        : revision === 2
          ? AGZ_FIXTURE_PROVENANCE.taskRevision2
          : AGZ_FIXTURE_PROVENANCE.taskRevision3;
    }
    if (noteId === AGZ_FIXTURE_IDS.noteOrphan) {
      return AGZ_FIXTURE_IDS.missingProvenance;
    }
    const mapping: Record<string, string> = {
      [AGZ_FIXTURE_IDS.noteRule]: AGZ_FIXTURE_PROVENANCE.rule,
      [AGZ_FIXTURE_IDS.noteUnicode]: AGZ_FIXTURE_PROVENANCE.unicode,
      [AGZ_FIXTURE_IDS.noteSupersededProcedure]:
        AGZ_FIXTURE_PROVENANCE.supersededProcedure,
      [AGZ_FIXTURE_IDS.noteArchivedResearch]:
        AGZ_FIXTURE_PROVENANCE.archivedResearch,
      [AGZ_FIXTURE_IDS.noteDuplicateTitle]:
        AGZ_FIXTURE_PROVENANCE.duplicateTitle,
      [AGZ_FIXTURE_IDS.notePreference]: AGZ_FIXTURE_PROVENANCE.preference,
      [AGZ_FIXTURE_IDS.noteArchivedGap]: AGZ_FIXTURE_PROVENANCE.archivedGap,
    };
    return mapping[noteId] ?? AGZ_FIXTURE_IDS.missingProvenance;
  };

  const revisions: RevisionSpec[] = [];
  for (const note of notes) {
    for (let revision = 1; revision <= note.current_revision; revision++) {
      // N9 senaryosu: current_revision 2 der ama yalnız revision 1 vardır.
      if (
        note.id === AGZ_FIXTURE_IDS.noteArchivedGap &&
        revision > 1
      ) {
        continue;
      }
      const isCurrentProcedureOldRevision =
        note.id === AGZ_FIXTURE_IDS.noteCurrentProcedure && revision === 1;
      const isHistoryNote =
        note.id === AGZ_FIXTURE_IDS.noteTask && revision < note.current_revision;
      const title = note.title;
      const summary = isCurrentProcedureOldRevision
        ? "Eski dağıtım adımları (revision 1)"
        : note.summary;
      const content = isCurrentProcedureOldRevision
        ? "Eski adımlar: elle kopyala, servisi yeniden başlat."
        : isHistoryNote
          ? `${note.content} (revision ${revision} taslağı)`
          : note.content;
      const kind = isHistoryNote ? "context" : note.kind;
      const contentHash = isCurrentProcedureOldRevision
        ? negative
          ? "1".repeat(64)
          : noteContentHash(kind, title, summary, content)
        : noteContentHash(kind, title, summary, content);
      revisions.push({
        projectId: note.project_id,
        noteId: note.id,
        revision,
        kind,
        title,
        summary,
        content,
        sizeClass: note.size_class,
        pinned: note.pinned === 1,
        status: note.status,
        supersedesId: note.supersedes_id,
        subjectKey: note.subject_key,
        contentHash,
        provenanceId: provenanceFor(note.id, revision),
      });
    }
  }

  for (const revision of revisions) {
    db.run(
      `INSERT INTO note_revisions
         (project_id, note_id, revision, kind, title, summary, content, size_class,
          pinned, status, supersedes_id, subject_key, content_hash, provenance_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        revision.projectId,
        revision.noteId,
        revision.revision,
        revision.kind,
        revision.title,
        revision.summary,
        revision.content,
        revision.sizeClass,
        revision.pinned,
        revision.status,
        revision.supersedesId,
        revision.subjectKey,
        revision.contentHash,
        revision.provenanceId,
        t(20 + revision.revision),
      ],
    );
  }
}

function insertProvenance(
  db: WritableSqliteConnection,
  alpha: string,
  negative: boolean,
): void {
  const beta = AGZ_FIXTURE_IDS.projectBeta;
  const archive = AGZ_FIXTURE_IDS.projectArchive;
  const specs: ProvenanceSpec[] = [
    {
      id: AGZ_FIXTURE_PROVENANCE.rule,
      projectId: alpha,
      noteId: AGZ_FIXTURE_IDS.noteRule,
      sourceType: "mcp-manual",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.unicode,
      projectId: alpha,
      noteId: AGZ_FIXTURE_IDS.noteUnicode,
      sourceType: "mcp-manual",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.supersededProcedure,
      projectId: alpha,
      noteId: AGZ_FIXTURE_IDS.noteSupersededProcedure,
      sourceType: "migration",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.procedureRevision1,
      projectId: alpha,
      noteId: AGZ_FIXTURE_IDS.noteCurrentProcedure,
      sourceType: "mcp-manual",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.procedureRevision2,
      projectId: alpha,
      noteId: AGZ_FIXTURE_IDS.noteCurrentProcedure,
      sourceType: "opencode-capture",
      captureEventId: "e".repeat(64),
      sourceSessionId: "sess-1",
      sourceMessageId: "msg-4",
      sourceOrdinal: 0,
      sourceToolCallId: null,
      redactionVersion: "redaction/1",
      extractorVersion: "deterministic-extractor/1",
      confidence: 0.97,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.archivedResearch,
      projectId: alpha,
      noteId: AGZ_FIXTURE_IDS.noteArchivedResearch,
      sourceType: "legacy-import",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: "redaction/1",
      extractorVersion: "deterministic-extractor/1",
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.duplicateTitle,
      projectId: alpha,
      noteId: AGZ_FIXTURE_IDS.noteDuplicateTitle,
      sourceType: "mcp-manual",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.preference,
      projectId: beta,
      noteId: AGZ_FIXTURE_IDS.notePreference,
      sourceType: "mcp-manual",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.taskRevision1,
      projectId: beta,
      noteId: AGZ_FIXTURE_IDS.noteTask,
      sourceType: "migration",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.taskRevision2,
      projectId: beta,
      noteId: AGZ_FIXTURE_IDS.noteTask,
      sourceType: "opencode-capture",
      captureEventId: "f".repeat(64),
      sourceSessionId: "sess-2",
      sourceMessageId: "msg-9",
      sourceOrdinal: 1,
      sourceToolCallId: null,
      redactionVersion: "redaction/1",
      extractorVersion: "deterministic-extractor/1",
      confidence: 0.95,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.taskRevision3,
      projectId: beta,
      noteId: AGZ_FIXTURE_IDS.noteTask,
      sourceType: "admin",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: AGZ_FIXTURE_PROVENANCE.archivedGap,
      projectId: archive,
      noteId: AGZ_FIXTURE_IDS.noteArchivedGap,
      sourceType: "mcp-manual",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: null,
      extractorVersion: null,
      confidence: null,
    },
    {
      id: "c0000000-0000-4000-8000-0000000000fe",
      projectId: alpha,
      noteId: AGZ_FIXTURE_IDS.missingNote,
      sourceType: "legacy-import",
      captureEventId: null,
      sourceSessionId: null,
      sourceMessageId: null,
      sourceOrdinal: null,
      sourceToolCallId: null,
      redactionVersion: "redaction/1",
      extractorVersion: "deterministic-extractor/1",
      confidence: null,
    },
  ];

  for (const spec of specs) {
    if (
      !negative &&
      (isNegativeNote(spec.noteId) ||
        spec.noteId === AGZ_FIXTURE_IDS.missingNote)
    )
      continue;
    db.run(
      `INSERT INTO note_provenance
         (id, project_id, note_id, source_type, capture_event_id, source_session_id,
          source_message_id, source_ordinal, source_tool_call_id, redaction_version,
          extractor_version, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        spec.id,
        spec.projectId,
        spec.noteId,
        spec.sourceType,
        spec.captureEventId,
        spec.sourceSessionId,
        spec.sourceMessageId,
        spec.sourceOrdinal,
        spec.sourceToolCallId,
        spec.redactionVersion,
        spec.extractorVersion,
        spec.confidence,
        t(30),
      ],
    );
  }
}

function insertEdges(
  db: WritableSqliteConnection,
  alpha: string,
  negative: boolean,
): void {
  const beta = AGZ_FIXTURE_IDS.projectBeta;
  const specs: EdgeSpec[] = [
    {
      id: AGZ_FIXTURE_EDGES.supports,
      projectId: alpha,
      sourceId: AGZ_FIXTURE_IDS.noteRule,
      targetId: AGZ_FIXTURE_IDS.noteUnicode,
      predicate: "SUPPORTS",
    },
    {
      id: AGZ_FIXTURE_EDGES.derivedFrom,
      projectId: alpha,
      sourceId: AGZ_FIXTURE_IDS.noteUnicode,
      targetId: AGZ_FIXTURE_IDS.noteArchivedResearch,
      predicate: "DERIVED_FROM",
    },
    {
      id: AGZ_FIXTURE_EDGES.partOf,
      projectId: alpha,
      sourceId: negative
        ? AGZ_FIXTURE_IDS.noteOrphan
        : AGZ_FIXTURE_IDS.noteArchivedResearch,
      targetId: AGZ_FIXTURE_IDS.noteRule,
      predicate: "PART_OF",
    },
    {
      id: AGZ_FIXTURE_EDGES.about,
      projectId: beta,
      sourceId: AGZ_FIXTURE_IDS.notePreference,
      targetId: AGZ_FIXTURE_IDS.noteTask,
      predicate: "ABOUT",
    },
    {
      id: AGZ_FIXTURE_EDGES.precedes,
      projectId: beta,
      sourceId: AGZ_FIXTURE_IDS.noteTask,
      targetId: AGZ_FIXTURE_IDS.notePreference,
      predicate: "PRECEDES",
    },
    {
      id: AGZ_FIXTURE_EDGES.supersedes,
      projectId: alpha,
      sourceId: AGZ_FIXTURE_IDS.noteCurrentProcedure,
      targetId: AGZ_FIXTURE_IDS.noteSupersededProcedure,
      predicate: "SUPERSEDES",
    },
    {
      id: AGZ_FIXTURE_EDGES.missingEndpoint,
      projectId: alpha,
      sourceId: AGZ_FIXTURE_IDS.noteRule,
      targetId: AGZ_FIXTURE_IDS.missingNote,
      predicate: "SUPPORTS",
    },
    {
      id: AGZ_FIXTURE_EDGES.crossProject,
      projectId: alpha,
      sourceId: AGZ_FIXTURE_IDS.noteRule,
      targetId: AGZ_FIXTURE_IDS.notePreference,
      predicate: "ABOUT",
    },
  ];

  for (const spec of specs) {
    if (
      !negative &&
      (isNegativeNote(spec.sourceId) || isNegativeNote(spec.targetId))
    )
      continue;
    if (
      !negative &&
      (spec.id === AGZ_FIXTURE_EDGES.missingEndpoint ||
        spec.id === AGZ_FIXTURE_EDGES.crossProject)
    )
      continue;
    db.run(
      `INSERT INTO note_edges (id, project_id, source_id, target_id, predicate, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [spec.id, spec.projectId, spec.sourceId, spec.targetId, spec.predicate, t(40)],
    );
  }
}

function insertBindingsAndCapture(
  db: WritableSqliteConnection,
  alpha: string,
): void {
  db.run(
    `INSERT INTO project_bindings
       (binding_key, project_id, source, source_project_id, workspace_id,
        canonical_path_hash, created_at, updated_at)
     VALUES (?, ?, 'opencode-v2', ?, ?, ?, ?, ?)`,
    [
      AGZ_FIXTURE_BINDING_KEY,
      alpha,
      "oc-project-1",
      "oc-workspace-1",
      "2".repeat(64),
      t(50),
      t(50),
    ],
  );
  db.run(
    `INSERT INTO capture_checkpoints
       (session_id, binding_key, project_id, state, last_message_id, last_reconciled_at,
        next_reconcile_at, failure_count, lease_owner, lease_expires_at, created_at, updated_at)
     VALUES ('sess-1', ?, ?, 'active', 'msg-4', ?, ?, 0, NULL, NULL, ?, ?)`,
    [AGZ_FIXTURE_BINDING_KEY, alpha, t(51), t(52), t(50), t(52)],
  );
  db.run(
    `INSERT INTO capture_events
       (idempotency_key, contract, project_id, binding_key, event_kind, source_session_id,
        source_message_id, source_ordinal, source_tool_call_id, payload_json, payload_hash,
        redaction_version, state, attempt_count, note_id, last_error_code, generation,
        created_at, updated_at, processed_at)
     VALUES (?, 'agz-memory.capture/2', ?, ?, 'assistant-candidate', 'sess-1',
             'msg-4', 0, NULL, NULL, NULL, 'redaction/1', 'materialized', 1, ?, NULL, 0,
             ?, ?, ?)`,
    [
      "e".repeat(64),
      alpha,
      AGZ_FIXTURE_BINDING_KEY,
      AGZ_FIXTURE_IDS.noteCurrentProcedure,
      t(53),
      t(54),
      t(54),
    ],
  );
  db.run(
    `INSERT INTO capture_events
       (idempotency_key, contract, project_id, binding_key, event_kind, source_session_id,
        source_message_id, source_ordinal, source_tool_call_id, payload_json, payload_hash,
        redaction_version, state, attempt_count, note_id, last_error_code, generation,
        created_at, updated_at, processed_at)
     VALUES (?, 'agz-memory.capture/2', ?, ?, 'session-summary', 'sess-2',
             'msg-summary', NULL, NULL, NULL, NULL, 'redaction/1', 'shadowed', 1, NULL, NULL, 0,
             ?, ?, NULL)`,
    ["f".repeat(64), alpha, AGZ_FIXTURE_BINDING_KEY, t(55), t(56)],
  );
}

function insertOutbox(db: WritableSqliteConnection, alpha: string): void {
  const archive = AGZ_FIXTURE_IDS.projectArchive;
  const unicodeHash = noteContentHash(
    "fact",
    "Ünicode Başlık 🧠 — ğüşiöçİı",
    "Emoji ve Türkçe",
    "İçerik: \u0130stanbul, \u00e7ağrı, 🤝, e\u0301 (combining).",
  );
  db.run(
    `INSERT INTO index_outbox
       (backend, operation_key, operation, project_id, note_id, revision, content_hash,
        generation, lease_generation, fence, state, attempt_count, available_at,
        lease_owner, lease_expires_at, heartbeat_at, last_error_code, created_at, completed_at)
     VALUES ('local-fts', ?, 'upsert-note', ?, ?, 1, ?, 0, 0, 0, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, NULL)`,
    [
      "3".repeat(64),
      alpha,
      AGZ_FIXTURE_IDS.noteUnicode,
      unicodeHash,
      t(60),
      t(60),
    ],
  );
  db.run(
    `INSERT INTO index_outbox
       (backend, operation_key, operation, project_id, note_id, revision, content_hash,
        generation, lease_generation, fence, state, attempt_count, available_at,
        lease_owner, lease_expires_at, heartbeat_at, last_error_code, created_at, completed_at)
     VALUES ('local-fts', ?, 'delete-note', ?, ?, 1, NULL, 0, 0, 0, 'dead', 3, ?, NULL, NULL, NULL, 'backend_unavailable', ?, ?)`,
    [
      "4".repeat(64),
      alpha,
      AGZ_FIXTURE_IDS.noteArchivedResearch,
      t(61),
      t(61),
      t(62),
    ],
  );
  db.run(
    `INSERT INTO index_outbox
       (backend, operation_key, operation, project_id, note_id, revision, content_hash,
        generation, lease_generation, fence, state, attempt_count, available_at,
        lease_owner, lease_expires_at, heartbeat_at, last_error_code, created_at, completed_at)
     VALUES ('local-fts', ?, 'purge-project', ?, NULL, NULL, NULL, 1, 0, 0, 'succeeded', 1, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    ["5".repeat(64), archive, t(63), t(63), t(64)],
  );
}

function t(offset: number): number {
  return AGZ_FIXTURE_T0 + offset * 1000;
}
