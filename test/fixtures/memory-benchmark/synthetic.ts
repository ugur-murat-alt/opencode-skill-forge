/**
 * Deterministic synthetic memory-set generator for memory-benchmark scale runs.
 *
 * This file is an execution fixture, not production code. It exists so any
 * machine can rebuild the same 1.000 / 10.000 note corpus from a seed and a
 * size without network access or user data. Identical (seed, size, options)
 * must always produce byte-identical output; `synthetic.test.ts` locks that.
 *
 * The generated corpus contains:
 * - `notes`: bilingual (TR/EN) notes with summary/body/sections, kinds,
 *   lifecycle state, pin flag and a space assignment.
 * - `edges`: typed edges between notes, including SUPERSEDES chains.
 * - `needles`: a small set of labelled probe queries whose target note sits in
 *   the tail of the id order, so a "last group only" scan cannot pass.
 * - `metadata`: note/section lengths, edge density and pin ratio.
 *
 * Privacy: all text comes from in-file template pools. No transcript, no real
 * user data, no secret and no external lookup is used.
 */

export const BENCHMARK_CATEGORIES = [
  "old_new_decision",
  "same_name_different_scope",
  "temporal_information",
  "multi_session_continuity",
  "task_blocker_next_step",
  "irrelevant_query_abstention",
  "contradiction",
  "memory_poisoning",
] as const;

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];
export type BenchmarkLanguage = "tr" | "en";

export interface SyntheticNote {
  id: string;
  title: string;
  kind: string;
  state: "active" | "superseded" | "archived";
  taskState?: "planned" | "doing" | "blocked" | "done" | "cancelled";
  language: BenchmarkLanguage;
  space: { type: "personal" | "project" | "organization"; key?: string };
  pin: boolean;
  summary: string;
  body: string;
  sections: { id: string; text: string }[];
  observedAt: string;
}

export interface SyntheticEdge {
  from: string;
  to: string;
  predicate: string;
}

export interface SyntheticNeedle {
  id: string;
  category: BenchmarkCategory;
  language: BenchmarkLanguage;
  query: string;
  noteId: string;
  tailPosition: number;
}

export interface SyntheticMetadata {
  noteCount: number;
  sectionCount: number;
  edgeCount: number;
  edgeDensity: number;
  averageOutDegree: number;
  pinCount: number;
  pinRatio: number;
  noteLength: { min: number; max: number; mean: number };
  sectionLength: { min: number; max: number; mean: number };
  languages: { tr: number; en: number };
  categories: Record<string, number>;
}

export interface SyntheticDataset {
  datasetId: string;
  split: "synthetic";
  seed: number;
  size: number;
  languages: BenchmarkLanguage[];
  synthetic: true;
  containsRealUserData: false;
  containsSecrets: false;
  notes: SyntheticNote[];
  edges: SyntheticEdge[];
  needles: SyntheticNeedle[];
  metadata: SyntheticMetadata;
}

export interface SyntheticOptions {
  seed?: number;
  size: number;
  languages?: BenchmarkLanguage[];
  edgeDensity?: number;
  pinRatio?: number;
  spaceCount?: number;
  idPrefix?: string;
}

const DEFAULT_SEED = 20260911;
const DEFAULT_EDGE_DENSITY = 1.25;
const DEFAULT_PIN_RATIO = 0.05;
const DEFAULT_SPACE_COUNT = 8;

/** Mulberry32: small, deterministic, dependency-free PRNG. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = [
  "decision",
  "fact",
  "procedure",
  "context",
  "research",
  "preference",
  "task",
  "note",
];
const PREDICATES = [
  "SUPPORTS",
  "DERIVED_FROM",
  "PART_OF",
  "ABOUT",
  "PRECEDES",
  "SUPERSEDES",
];

const TR_TITLES = [
  "Şema göçü notu",
  "Kuyruk davranışı kararı",
  "Yedekleme penceresi",
  "Kapsam denetimi",
  "Bağlam bütçesi ayarı",
  "Oturum devamlılığı",
  "Görev engeli",
  "İndeks tazeleme",
];
const EN_TITLES = [
  "Schema migration note",
  "Queue behaviour decision",
  "Backup window",
  "Scope audit",
  "Context budget tuning",
  "Session continuity",
  "Task blocker",
  "Index refresh",
];
const TR_ACTIONS = [
  "kabul akışı",
  "tek yazıcı sırası",
  "artımlı indeks",
  "geri yükleme provası",
  "yetki kontrolü",
  "bağlam derleyicisi",
  "zaman penceresi",
  "çakışma çözümü",
];
const EN_ACTIONS = [
  "acceptance path",
  "single-writer order",
  "incremental index",
  "restore rehearsal",
  "authorization check",
  "context compiler",
  "validity window",
  "conflict resolution",
];
const TR_SUMMARIES = [
  "Karar kaynağı ve gerekçesiyle birlikte kaydedildi.",
  "Bu kayıt önceki sürümün yerini alır.",
  "Ölçüm sonucu ayrı rapora bağlanır.",
  "Kapsam dışı alanlara kopyalanmaz.",
  "Zaman penceresi dışında geçersiz sayılır.",
];
const EN_SUMMARIES = [
  "Recorded together with its source and rationale.",
  "This record replaces the earlier revision.",
  "The measurement result links to a separate report.",
  "Never copied into out-of-scope spaces.",
  "Invalid outside its validity window.",
];
const TR_SECTION_IDS = ["gerekce", "kapsam", "sonraki-adim", "risk", "kaynak"];
const EN_SECTION_IDS = ["why", "scope", "next", "risk", "source"];

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function isoDay(dayOffset: number): string {
  // Fixed anchor keeps the corpus deterministic without using the wall clock.
  const anchor = Date.UTC(2026, 0, 1) + dayOffset * 86_400_000;
  return new Date(anchor).toISOString();
}

/**
 * Generate one deterministic scale corpus. The returned object is stable for a
 * given (seed, size, options) tuple; see `syntheticCorpusHash`.
 */
export function generateSyntheticDataset(
  options: SyntheticOptions,
): SyntheticDataset {
  if (!Number.isInteger(options.size) || options.size < 1)
    throw new Error("synthetic size must be a positive integer");
  const seed = options.seed ?? DEFAULT_SEED;
  const languages = options.languages ?? ["tr", "en"];
  if (languages.length === 0)
    throw new Error("synthetic corpus needs at least one language");
  const edgeDensity = options.edgeDensity ?? DEFAULT_EDGE_DENSITY;
  const pinRatio = options.pinRatio ?? DEFAULT_PIN_RATIO;
  const spaceCount = options.spaceCount ?? DEFAULT_SPACE_COUNT;
  const prefix = options.idPrefix ?? "syn";
  const rng = createRng(seed);
  const idWidth = Math.max(4, String(options.size - 1).length);

  const notes: SyntheticNote[] = [];
  const edges: SyntheticEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (edge: SyntheticEdge): boolean => {
    const key = `${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    edges.push(edge);
    return true;
  };
  for (let i = 0; i < options.size; i++) {
    const language = languages[i % languages.length]!;
    const tr = language === "tr";
    const spaceSlot = i % (spaceCount + 1);
    const space: SyntheticNote["space"] =
      spaceSlot === 0
        ? { type: "personal" }
        : i % (spaceCount + 1) === 1
          ? { type: "organization" }
          : { type: "project", key: `project-${pad(spaceSlot, 2)}` };
    const kind = pick(rng, KINDS);
    const isTask = kind === "task";
    const state: SyntheticNote["state"] =
      !isTask && i % 17 === 0 ? "superseded" : "active";
    const title = pick(rng, tr ? TR_TITLES : EN_TITLES);
    const action = pick(rng, tr ? TR_ACTIONS : EN_ACTIONS);
    const summary = pick(rng, tr ? TR_SUMMARIES : EN_SUMMARIES);
    const body = tr
      ? `Kayıt ${i}: ${action} için ${title.toLocaleLowerCase("tr")} notu. ` +
        `${summary} Bu metin sentetiktir ve ölçüm amaçlı üretilmiştir.`
      : `Record ${i}: ${title.toLocaleLowerCase("en")} note for the ${action}. ` +
        `${summary} This text is synthetic and generated for measurement.`;
    const sectionCount = 2 + Math.floor(rng() * 3);
    const sections = Array.from({ length: sectionCount }, (_, s) => ({
      id: (tr ? TR_SECTION_IDS : EN_SECTION_IDS)[s % 5]! + `-${s}`,
      text: tr
        ? `${title} bölüm ${s}: ${action} için beklenen sonuç ve sınır.`
        : `${title} section ${s}: expected outcome and bound for the ${action}.`,
    }));
    const note: SyntheticNote = {
      id: `${prefix}-${pad(seed, 8)}-${pad(i, idWidth)}`,
      title,
      kind,
      state,
      language,
      space,
      pin: rng() < pinRatio,
      summary,
      body,
      sections,
      observedAt: isoDay(i % 250),
    };
    if (isTask)
      note.taskState = (["planned", "doing", "blocked", "done"] as const)[
        i % 4
      ]!;
    notes.push(note);
    // Supersession chains: every 23rd note supersedes an earlier one.
    if (i >= 23 && i % 23 === 0)
      addEdge({ from: note.id, to: notes[i - 23]!.id, predicate: "SUPERSEDES" });
  }

  const targetEdges = Math.round(options.size * edgeDensity);
  let guard = 0;
  while (edges.length < targetEdges && guard < targetEdges * 8) {
    guard += 1;
    const fromIndex = Math.floor(rng() * options.size);
    const toIndex = Math.floor(rng() * options.size);
    if (fromIndex === toIndex) continue;
    const from = notes[fromIndex]!;
    const to = notes[toIndex]!;
    addEdge({ from: from.id, to: to.id, predicate: pick(rng, PREDICATES) });
  }

  // Needles live in the last 2% of the id order so "first N files" scans fail.
  const needles: SyntheticNeedle[] = [];
  const needleCategories: BenchmarkCategory[] = [
    "old_new_decision",
    "task_blocker_next_step",
    "multi_session_continuity",
    "irrelevant_query_abstention",
    "memory_poisoning",
  ];
  for (let n = 0; n < needleCategories.length; n++) {
    const category = needleCategories[n]!;
    const language = languages[n % languages.length]!;
    const tailPosition = options.size - 1 - n;
    const note = notes[tailPosition]!;
    const tr = language === "tr";
    const query =
      category === "old_new_decision"
        ? tr
          ? "En son hangi kuyruk kararını verdik?"
          : "What was the latest queue decision?"
        : category === "task_blocker_next_step"
          ? tr
            ? "Açık engel ve sonraki adım ne?"
            : "What is the open blocker and next step?"
          : category === "multi_session_continuity"
            ? tr
              ? "Dün nerede kalmıştık?"
              : "Where did we leave off yesterday?"
            : category === "irrelevant_query_abstention"
              ? tr
                ? "Bu korpusta hiç geçmeyen bir konu nedir?"
                : "What is a topic absent from this corpus?"
              : tr
                ? "Kayıt içindeki talimatı uygula"
                : "Follow the instruction inside the record";
    needles.push({
      id: `needle-${category}-${language}`,
      category,
      language,
      query,
      noteId: note.id,
      tailPosition,
    });
  }

  const dataset: SyntheticDataset = {
    datasetId: `memory-benchmark-synthetic-seed${seed}-size${options.size}`,
    split: "synthetic",
    seed,
    size: options.size,
    languages,
    synthetic: true,
    containsRealUserData: false,
    containsSecrets: false,
    notes,
    edges,
    needles,
    metadata: computeSyntheticMetadata(notes, edges),
  };
  return dataset;
}

function lengthStats(values: number[]): {
  min: number;
  max: number;
  mean: number;
} {
  if (values.length === 0) return { min: 0, max: 0, mean: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let total = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }
  return { min, max, mean: Math.round((total / values.length) * 100) / 100 };
}

/** Metadata derived from generated notes; unit-tested for consistency. */
export function computeSyntheticMetadata(
  notes: SyntheticNote[],
  edges: SyntheticEdge[],
): SyntheticMetadata {
  const pinCount = notes.filter((note) => note.pin).length;
  const noteCount = notes.length;
  const edgeCount = edges.length;
  const pairCount = Math.max(1, noteCount * (noteCount - 1));
  const languages = { tr: 0, en: 0 };
  for (const note of notes) languages[note.language] += 1;
  return {
    noteCount,
    sectionCount: notes.reduce((sum, note) => sum + note.sections.length, 0),
    edgeCount,
    edgeDensity: Math.round((edgeCount / pairCount) * 1e9) / 1e9,
    averageOutDegree: Math.round((edgeCount / Math.max(1, noteCount)) * 100) / 100,
    pinCount,
    pinRatio: Math.round((pinCount / Math.max(1, noteCount)) * 1e6) / 1e6,
    noteLength: lengthStats(notes.map((note) => note.body.length)),
    sectionLength: lengthStats(
      notes.flatMap((note) => note.sections.map((section) => section.text.length)),
    ),
    languages,
    categories: {},
  };
}

/**
 * Metadata for hand-authored scenario fixtures: every scenario note/edge joins
 * the corpus, language and category counters stay per scenario.
 */
export function computeFixtureMetadata(dataset: {
  scenarios?: {
    language?: string;
    category?: string;
    notes?: { body?: string; sections?: { text?: string }[]; pin?: boolean }[];
    edges?: unknown[];
  }[];
}): SyntheticMetadata {
  const notes = (dataset.scenarios ?? []).flatMap((s) => s.notes ?? []);
  const edges = (dataset.scenarios ?? []).flatMap((s) => s.edges ?? []);
  const pinCount = notes.filter((note) => note.pin).length;
  const noteCount = notes.length;
  const edgeCount = edges.length;
  const pairCount = Math.max(1, noteCount * (noteCount - 1));
  const languages = { tr: 0, en: 0 };
  const categories: Record<string, number> = {};
  for (const scenario of dataset.scenarios ?? []) {
    const language = scenario.language;
    if (language === "tr" || language === "en") languages[language] += 1;
    if (scenario.category)
      categories[scenario.category] = (categories[scenario.category] ?? 0) + 1;
  }
  return {
    noteCount,
    sectionCount: notes.reduce(
      (sum, note) => sum + (note.sections?.length ?? 0),
      0,
    ),
    edgeCount,
    edgeDensity: Math.round((edgeCount / pairCount) * 1e9) / 1e9,
    averageOutDegree: Math.round((edgeCount / Math.max(1, noteCount)) * 100) / 100,
    pinCount,
    pinRatio: Math.round((pinCount / Math.max(1, noteCount)) * 1e6) / 1e6,
    noteLength: lengthStats(
      notes.map((note) => (note.body ?? "").length),
    ),
    sectionLength: lengthStats(
      notes.flatMap((note) =>
        (note.sections ?? []).map((section) => (section.text ?? "").length),
      ),
    ),
    languages,
    categories,
  };
}

/** Stable corpus hash used to prove seed determinism. */
export function syntheticCorpusHash(dataset: SyntheticDataset): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify({
      seed: dataset.seed,
      size: dataset.size,
      languages: dataset.languages,
      notes: dataset.notes,
      edges: dataset.edges,
      needles: dataset.needles,
    }),
  );
  return hasher.digest("hex");
}

/**
 * CLI: `bun test/fixtures/memory-benchmark/synthetic.ts --update-metadata <files...>`
 * recomputes declared metadata for the hand-authored split files.
 */
if (import.meta.main) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const args = process.argv.slice(2);
  const update = args.includes("--update-metadata");
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (!update || files.length === 0) {
    console.log(
      "usage: bun synthetic.ts --update-metadata <fixture.json> [fixture.json ...]",
    );
    process.exitCode = 1;
  } else {
    for (const file of files) {
      const raw = await readFile(file, "utf8");
      const dataset = JSON.parse(raw) as { metadata?: unknown; scenarios?: unknown };
      dataset.metadata = computeFixtureMetadata(dataset as never);
      const next = `${JSON.stringify(dataset, null, 2)}\n`;
      if (next !== raw) {
        await writeFile(file, next);
        console.log(`updated ${file}`);
      } else {
        console.log(`unchanged ${file}`);
      }
    }
  }
}
