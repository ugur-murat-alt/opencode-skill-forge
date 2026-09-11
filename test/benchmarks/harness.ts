/**
 * Data-driven memory benchmark harness (issue #41 §2).
 *
 * This is the measurement skeleton, not a memory implementation. It loads a
 * fixture split, asks a `BenchmarkSystem` adapter for each scenario, converts
 * the responses into `RetrievalObservation`s, computes metrics and evaluates
 * pre-registered thresholds. Until a memory module exists, unit tests drive it
 * with deterministic fake adapters.
 *
 * Contract notes:
 * - Latency is measured with an injected clock so tests are deterministic;
 *   a system may also report its own `latencyMs`.
 * - Token counts go through `estimateContextTokens`: real tokenizer when
 *   provided, otherwise a labelled estimate. Character count is never used as
 *   a token count.
 * - `evaluateThresholds` never mutates the threshold file and never turns a
 *   missing measurement into a pass. Unknown metric names are an error.
 */

import { readFile } from "node:fs/promises";
import {
  aggregateMetrics,
  estimateContextTokens,
  type MetricSummary,
  type RetrievalObservation,
  type TokenizerLike,
} from "./metrics.js";

export interface BenchmarkSpace {
  type: "personal" | "project" | "organization";
  key?: string;
}

export interface BenchmarkBudget {
  startupMaxTokens: number;
  recallMaxTokens: number;
  maxCards: number;
  status?: string;
}

export interface BenchmarkScenario {
  id: string;
  category: string;
  language: "tr" | "en";
  space: BenchmarkSpace;
  asOf: string;
  query: string;
  session: { id: string; continues?: string[] };
  notes: {
    id: string;
    title: string;
    kind: string;
    state: "active" | "superseded" | "archived";
    taskState?: string;
    space: BenchmarkSpace;
    pin: boolean;
    summary: string;
    body: string;
    sections: { id: string; text: string }[];
    observedAt?: string;
  }[];
  edges: { from: string; to: string; predicate: string }[];
  expect: {
    retrieval: {
      relevant: string[];
      stale: string[];
      forbidden: string[];
      quarantine?: string[];
      abstain: boolean;
    };
    answer: {
      mustCite?: string[];
      mustNotPresentAsCurrent?: string[];
      mustFlagContradiction?: boolean;
      mustNotFollowInstructionFrom?: string[];
    };
    task: {
      taskId: string;
      state: string;
      blockerId: string | null;
      nextStepId: string | null;
    } | null;
    autoWrite: { eligible: string[]; forbidden: string[] } | null;
  };
}

export interface BenchmarkDataset {
  datasetId: string;
  split: "tuning" | "acceptance";
  version: number;
  language: string;
  synthetic: true;
  containsRealUserData: false;
  containsSecrets: false;
  metadata: Record<string, unknown>;
  budget: BenchmarkBudget;
  scenarios: BenchmarkScenario[];
}

export interface RetrievalRequest {
  scenario: BenchmarkScenario;
  k: number;
  budget: BenchmarkBudget;
}

export interface RetrievalResponse {
  retrievedIds: string[];
  citedIds?: string[];
  abstained: boolean;
  claimedStaleAsCurrent?: boolean;
  followedPoisonIds?: string[];
  autoWrite?: {
    eligibleIds: string[];
    writtenIds: string[];
    wrongIds: string[];
  } | null;
  task?: {
    state: string | null;
    blockerId?: string | null;
    nextStepId?: string | null;
  } | null;
  contextText?: string;
  latencyMs?: number;
  latencyKind?: string;
  phase?: "startup" | "recall";
}

export interface BenchmarkSystem {
  name: string;
  retrieve(
    request: RetrievalRequest,
  ): Promise<RetrievalResponse> | RetrievalResponse;
}

export interface BudgetUsage {
  maxCardsReturned: number;
  maxCards: number;
  maxContextTokens: number;
  maxStartupTokens: number | null;
  maxRecallTokens: number | null;
  tokenMethod: string;
  tokenEstimated: boolean;
}

export interface BenchmarkReport {
  reportId: "memory-benchmark-report";
  reportVersion: 1;
  datasetId: string;
  split: "tuning" | "acceptance";
  datasetVersion: number;
  system: string;
  k: number;
  generatedAt: string | null;
  measurement: {
    clock: "injected" | "wall";
    tokenizer: string | null;
    tokenMethod: string;
    estimated: boolean;
    note: string;
  };
  budgetUsage: BudgetUsage;
  summary: MetricSummary;
  observations: RetrievalObservation[];
}

export interface ThresholdsFile {
  id: string;
  version: number;
  frozenAt: string;
  frozenBeforeMeasurement: boolean;
  measured: boolean;
  guarantee: boolean;
  status: string;
  source: string;
  notes: string[];
  budgets: {
    startupMaxTokens: number;
    recallMaxTokens: number;
    maxCards: number;
    status?: string;
  };
  latency: {
    warmLexicalGraphQueryP95Ms: number;
    cachedStartupContextP95Ms: number;
    percentileMethod: string;
    minimumSamples: number;
    status: string;
    separateMeasurements?: string[];
  };
  quality: {
    metric: string;
    direction: "min" | "max";
    value: number;
    status: string;
  }[];
  comparison: Record<string, unknown>;
}

export interface ThresholdResult {
  metric: string;
  scope: "quality" | "latency" | "budget";
  direction: "min" | "max";
  threshold: number;
  actual: number | null;
  status: "pass" | "fail" | "not-measured";
  note: string;
}

export const QUALITY_METRIC_KEYS = [
  "recall_at_k",
  "source_hit_at_k",
  "stale_claim_rate",
  "scope_leak_rate",
  "false_auto_write_rate",
  "auto_write_recall",
  "abstention_accuracy",
  "false_abstention_rate",
  "task_success_rate",
  "poison_follow_rate",
] as const;
export type QualityMetricKey = (typeof QUALITY_METRIC_KEYS)[number];

export function loadDataset(raw: string | unknown): BenchmarkDataset {
  const value =
    typeof raw === "string" ? (JSON.parse(raw) as unknown) : (raw as unknown);
  if (!isRecord(value)) throw new Error("dataset must be a JSON object");
  const dataset = value as Record<string, unknown>;
  for (const key of ["datasetId", "split", "language", "metadata"]) {
    if (!(key in dataset)) throw new Error(`dataset.${key} is required`);
  }
  if (dataset.synthetic !== true)
    throw new Error("dataset.synthetic must be true");
  if (dataset.containsRealUserData !== false)
    throw new Error("dataset.containsRealUserData must be false");
  if (dataset.containsSecrets !== false)
    throw new Error("dataset.containsSecrets must be false");
  if (dataset.split !== "tuning" && dataset.split !== "acceptance")
    throw new Error("dataset.split must be tuning or acceptance");
  if (!Number.isInteger(dataset.version) || (dataset.version as number) < 1)
    throw new Error("dataset.version must be a positive integer");
  const budget = dataset.budget as Record<string, unknown> | undefined;
  if (
    !isRecord(budget) ||
    !Number.isInteger(budget.startupMaxTokens) ||
    !Number.isInteger(budget.recallMaxTokens) ||
    !Number.isInteger(budget.maxCards)
  )
    throw new Error("dataset.budget requires integer token/card limits");
  if (!Array.isArray(dataset.scenarios) || dataset.scenarios.length === 0)
    throw new Error("dataset.scenarios must be a non-empty array");

  const scenarioIds = new Set<string>();
  const allNoteIds = new Set<string>();
  for (const item of dataset.scenarios) {
    const scenario = item as Record<string, unknown>;
    for (const key of [
      "id",
      "category",
      "language",
      "space",
      "query",
      "expect",
    ])
      if (!(key in scenario)) throw new Error(`scenario.${key} is required`);
    const id = String(scenario.id);
    if (scenarioIds.has(id)) throw new Error(`duplicate scenario id ${id}`);
    scenarioIds.add(id);
    if (scenario.language !== "tr" && scenario.language !== "en")
      throw new Error(`scenario ${id}: language must be tr or en`);
    if (!Array.isArray(scenario.notes))
      throw new Error(`scenario ${id}: notes must be an array`);
    if (!Array.isArray(scenario.edges))
      throw new Error(`scenario ${id}: edges must be an array`);
    const localNotes = new Set<string>();
    for (const note of scenario.notes) {
      const noteId = String((note as Record<string, unknown>).id);
      if (localNotes.has(noteId))
        throw new Error(`scenario ${id}: duplicate note id ${noteId}`);
      if (allNoteIds.has(noteId))
        throw new Error(`note id ${noteId} is reused across scenarios`);
      localNotes.add(noteId);
      allNoteIds.add(noteId);
    }
    for (const edge of scenario.edges) {
      const { from, to } = edge as { from: string; to: string };
      if (!localNotes.has(from) || !localNotes.has(to))
        throw new Error(
          `scenario ${id}: edge ${from}->${to} references unknown note`,
        );
    }
    const expect = scenario.expect as Record<string, unknown>;
    const retrieval = expect.retrieval as Record<string, unknown> | undefined;
    if (
      !isRecord(retrieval) ||
      !Array.isArray(retrieval.relevant) ||
      !Array.isArray(retrieval.stale) ||
      !Array.isArray(retrieval.forbidden) ||
      typeof retrieval.abstain !== "boolean"
    )
      throw new Error(`scenario ${id}: retrieval expectation is malformed`);
    for (const key of ["relevant", "stale", "forbidden", "quarantine"]) {
      const ids = (retrieval[key] as string[] | undefined) ?? [];
      for (const noteId of ids)
        if (!localNotes.has(noteId))
          throw new Error(
            `scenario ${id}: expect.${key} references unknown ${noteId}`,
          );
    }
    const overlap = (retrieval.relevant as string[]).filter((noteId) =>
      (retrieval.forbidden as string[]).includes(noteId),
    );
    if (overlap.length > 0)
      throw new Error(
        `scenario ${id}: relevant and forbidden overlap (${overlap})`,
      );
  }
  return value as unknown as BenchmarkDataset;
}

export async function loadDatasetFile(path: string): Promise<BenchmarkDataset> {
  return loadDataset(await readFile(path, "utf8"));
}

export interface RunBenchmarkOptions {
  dataset: BenchmarkDataset;
  system: BenchmarkSystem;
  k?: number;
  tokenizer?: TokenizerLike;
  clock?: () => number;
  generatedAt?: string | null;
}

export async function runBenchmark(
  options: RunBenchmarkOptions,
): Promise<BenchmarkReport> {
  const { dataset, system } = options;
  const k = options.k ?? dataset.budget.maxCards;
  const clock = options.clock ?? (() => performance.now());
  const observations: RetrievalObservation[] = [];
  for (const scenario of dataset.scenarios) {
    const started = clock();
    const response = await system.retrieve({
      scenario,
      k,
      budget: dataset.budget,
    });
    const latencyMs = response.latencyMs ?? clock() - started;
    const contextText = response.contextText ?? "";
    const tokens = estimateContextTokens(contextText, options.tokenizer);
    const auto = scenario.expect.autoWrite
      ? (response.autoWrite ?? {
          eligibleIds: [],
          writtenIds: [],
          wrongIds: [],
        })
      : null;
    observations.push({
      scenarioId: scenario.id,
      category: scenario.category,
      language: scenario.language,
      retrievedIds: response.retrievedIds,
      citedIds: response.citedIds ?? [],
      relevantIds: scenario.expect.retrieval.relevant,
      staleIds: scenario.expect.retrieval.stale,
      forbiddenIds: scenario.expect.retrieval.forbidden,
      poisonIds: scenario.expect.retrieval.quarantine ?? [],
      abstained: response.abstained,
      abstainExpected: scenario.expect.retrieval.abstain,
      claimedStaleAsCurrent: response.claimedStaleAsCurrent ?? false,
      followedPoisonIds: response.followedPoisonIds ?? [],
      autoWrite: auto,
      taskExpected: scenario.expect.task,
      taskObserved: response.task
        ? {
            state: response.task.state,
            blockerId: response.task.blockerId ?? null,
            nextStepId: response.task.nextStepId ?? null,
          }
        : null,
      latencyMs,
      latencyKind: response.latencyKind ?? "unspecified",
      phase: response.phase ?? "unknown",
      contextText,
      tokenCount: tokens.tokens,
      tokenMethod: tokens.method,
      tokenEstimated: tokens.estimated,
    });
  }
  const startup = observations.filter(
    (observation) => observation.phase === "startup",
  );
  const recall = observations.filter(
    (observation) => observation.phase === "recall",
  );
  const maxOf = (
    subset: RetrievalObservation[],
    pick: (observation: RetrievalObservation) => number,
  ) => (subset.length === 0 ? null : Math.max(...subset.map(pick)));
  return {
    reportId: "memory-benchmark-report",
    reportVersion: 1,
    datasetId: dataset.datasetId,
    split: dataset.split,
    datasetVersion: dataset.version,
    system: system.name,
    k,
    generatedAt: options.generatedAt ?? null,
    measurement: {
      clock: options.clock ? "injected" : "wall",
      tokenizer: options.tokenizer?.name ?? null,
      tokenMethod: options.tokenizer?.name ?? "utf8_bytes_div_2.5_estimate",
      estimated: !options.tokenizer,
      note: options.tokenizer
        ? "Token counts come from the provided tokenizer."
        : "Token counts are byte-based estimates (utf8 bytes / 2.5), not a real tokenizer and not character counts.",
    },
    budgetUsage: {
      maxCardsReturned:
        maxOf(observations, (observation) => observation.retrievedIds.length) ??
        0,
      maxCards: dataset.budget.maxCards,
      maxContextTokens:
        maxOf(observations, (observation) => observation.tokenCount) ?? 0,
      maxStartupTokens: maxOf(startup, (observation) => observation.tokenCount),
      maxRecallTokens: maxOf(recall, (observation) => observation.tokenCount),
      tokenMethod: options.tokenizer?.name ?? "utf8_bytes_div_2.5_estimate",
      tokenEstimated: !options.tokenizer,
    },
    summary: aggregateMetrics(observations, k),
    observations,
  };
}

interface ThresholdCheckInput {
  metric: string;
  scope: "quality" | "latency" | "budget";
  direction: "min" | "max";
  threshold: number;
  actual: number | null;
  note: string;
}

function check(input: ThresholdCheckInput): ThresholdResult {
  let status: ThresholdResult["status"] = "not-measured";
  if (input.actual !== null)
    status =
      input.direction === "min"
        ? input.actual >= input.threshold
          ? "pass"
          : "fail"
        : input.actual <= input.threshold
          ? "pass"
          : "fail";
  return {
    metric: input.metric,
    scope: input.scope,
    direction: input.direction,
    threshold: input.threshold,
    actual: input.actual,
    status,
    note: input.note,
  };
}

/**
 * Compare a report against the frozen threshold file. The function refuses to
 * invent a measurement: a missing latency kind or token phase is reported as
 * `not-measured`, never as a pass.
 */
export function evaluateThresholds(
  report: BenchmarkReport,
  thresholds: ThresholdsFile,
): ThresholdResult[] {
  const results: ThresholdResult[] = [];
  const summary = report.summary as unknown as Record<
    QualityMetricKey,
    { value: number | null; numerator: number; denominator: number }
  >;
  for (const entry of thresholds.quality) {
    if (!QUALITY_METRIC_KEYS.includes(entry.metric as QualityMetricKey))
      throw new Error(`unknown quality metric in thresholds: ${entry.metric}`);
    const value = summary[entry.metric as QualityMetricKey];
    results.push(
      check({
        metric: entry.metric,
        scope: "quality",
        direction: entry.direction,
        threshold: entry.value,
        actual: value?.value ?? null,
        note:
          value && value.value !== null
            ? `${value.numerator}/${value.denominator}`
            : "no sample for this metric",
      }),
    );
  }
  const warm = report.summary.latency_by_kind["warm_lexical_graph"];
  results.push(
    check({
      metric: "warm_lexical_graph_query_p95_ms",
      scope: "latency",
      direction: "max",
      threshold: thresholds.latency.warmLexicalGraphQueryP95Ms,
      actual:
        warm && warm.samples >= thresholds.latency.minimumSamples
          ? (warm.p95 ?? null)
          : null,
      note:
        (warm?.samples ?? 0) >= thresholds.latency.minimumSamples
          ? `${warm!.samples} samples`
          : `only ${warm?.samples ?? 0} samples; minimum ${thresholds.latency.minimumSamples} for a verdict`,
    }),
  );
  const cached = report.summary.latency_by_kind["cached_startup"];
  results.push(
    check({
      metric: "cached_startup_context_p95_ms",
      scope: "latency",
      direction: "max",
      threshold: thresholds.latency.cachedStartupContextP95Ms,
      actual:
        cached && cached.samples >= thresholds.latency.minimumSamples
          ? (cached.p95 ?? null)
          : null,
      note:
        (cached?.samples ?? 0) >= thresholds.latency.minimumSamples
          ? `${cached!.samples} samples`
          : `only ${cached?.samples ?? 0} samples; minimum ${thresholds.latency.minimumSamples} for a verdict`,
    }),
  );
  results.push(
    check({
      metric: "max_cards_returned",
      scope: "budget",
      direction: "max",
      threshold: thresholds.budgets.maxCards,
      actual: report.budgetUsage.maxCardsReturned,
      note: `returned at most ${report.budgetUsage.maxCardsReturned} cards`,
    }),
  );
  results.push(
    check({
      metric: "startup_max_tokens",
      scope: "budget",
      direction: "max",
      threshold: thresholds.budgets.startupMaxTokens,
      actual: report.budgetUsage.maxStartupTokens,
      note: report.budgetUsage.tokenEstimated
        ? "estimated token count; not a tokenizer measurement"
        : `tokenizer ${report.budgetUsage.tokenMethod}`,
    }),
  );
  results.push(
    check({
      metric: "recall_max_tokens",
      scope: "budget",
      direction: "max",
      threshold: thresholds.budgets.recallMaxTokens,
      actual: report.budgetUsage.maxRecallTokens,
      note: report.budgetUsage.tokenEstimated
        ? "estimated token count; not a tokenizer measurement"
        : `tokenizer ${report.budgetUsage.tokenMethod}`,
    }),
  );
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
