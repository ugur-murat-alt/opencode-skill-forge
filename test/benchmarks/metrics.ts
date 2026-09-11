/**
 * Memory benchmark metric mathematics (issue #41 §2).
 *
 * Pure functions only: no database, no clock, no randomness. The harness feeds
 * observations produced by any system under test; these functions turn them
 * into per-scenario and aggregate numbers. Every ratio carries its explicit
 * numerator/denominator so a small or empty sample is visible instead of being
 * hidden inside a decimal.
 *
 * Deliberately NOT here: any claim that an unmeasured value is a guarantee.
 * Token counting is either a real tokenizer result (`estimated: false`) or a
 * byte-based estimate that the report must label as an estimate. Character
 * count is never reported as a token count.
 */

export interface AutoWriteRecord {
  eligibleIds: string[];
  writtenIds: string[];
  wrongIds: string[];
}

export interface TaskExpectation {
  taskId: string;
  state: string;
  blockerId: string | null;
  nextStepId: string | null;
}

export interface TaskObservation {
  state: string | null;
  blockerId: string | null;
  nextStepId: string | null;
}

export interface RetrievalObservation {
  scenarioId: string;
  category: string;
  language: string;
  retrievedIds: string[];
  citedIds: string[];
  relevantIds: string[];
  staleIds: string[];
  forbiddenIds: string[];
  poisonIds: string[];
  /** System chose to return no answer for an out-of-scope/unsupported query. */
  abstained: boolean;
  abstainExpected: boolean;
  /** Stale/superseded source was presented as the current answer. */
  claimedStaleAsCurrent: boolean;
  /** The system executed an instruction embedded in an untrusted record. */
  followedPoisonIds: string[];
  autoWrite: AutoWriteRecord | null;
  taskExpected: TaskExpectation | null;
  taskObserved: TaskObservation | null;
  latencyMs: number;
  latencyKind: string;
  phase: "startup" | "recall" | "unknown";
  contextText: string;
  /** Token count from a real tokenizer or a labelled byte-based estimate. */
  tokenCount: number;
  tokenMethod: string;
  tokenEstimated: boolean;
}

export interface TokenEstimate {
  tokens: number;
  method: string;
  estimated: boolean;
}

export interface TokenizerLike {
  name: string;
  count(text: string): number;
}

export interface MetricValue {
  value: number | null;
  numerator: number;
  denominator: number;
}

export interface TokenSummary {
  samples: number;
  total: number;
  mean: number;
  max: number;
  methods: Record<string, number>;
  estimatedSamples: number;
}

export interface LatencySummary {
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface MetricSummary {
  scenarioCount: number;
  byCategory: Record<string, number>;
  byLanguage: Record<string, number>;
  recall_at_k: MetricValue;
  source_hit_at_k: MetricValue;
  stale_claim_rate: MetricValue;
  scope_leak_rate: MetricValue;
  false_auto_write_rate: MetricValue;
  auto_write_recall: MetricValue;
  abstention_accuracy: MetricValue;
  false_abstention_rate: MetricValue;
  task_success_rate: MetricValue;
  poison_follow_rate: MetricValue;
  context_tokens: TokenSummary;
  context_tokens_by_phase: Record<string, TokenSummary>;
  latency_ms: LatencySummary;
  latency_by_kind: Record<string, LatencySummary>;
}

const round = (value: number, digits = 6): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

function metric(numerator: number, denominator: number): MetricValue {
  return {
    value: denominator === 0 ? null : round(numerator / denominator),
    numerator: round(numerator),
    denominator,
  };
}

function meanMetric(values: (number | null)[]): MetricValue {
  const present = values.filter((value): value is number => value !== null);
  return metric(
    present.reduce((sum, value) => sum + value, 0),
    present.length,
  );
}

/** Fraction of the expected relevant ids present in the first k results. */
export function recallAtK(
  retrievedIds: string[],
  relevantIds: string[],
  k: number,
): number | null {
  const relevant = new Set(relevantIds);
  if (relevant.size === 0) return null;
  const top = new Set(retrievedIds.slice(0, Math.max(0, k)));
  let found = 0;
  for (const id of relevant) if (top.has(id)) found += 1;
  return round(found / relevant.size);
}

/** 1 when at least one expected source appears in the first k results. */
export function hitAtK(
  retrievedIds: string[],
  relevantIds: string[],
  k: number,
): number | null {
  if (relevantIds.length === 0) return null;
  const relevant = new Set(relevantIds);
  const top = retrievedIds.slice(0, Math.max(0, k));
  return top.some((id) => relevant.has(id)) ? 1 : 0;
}

/**
 * Share of scenarios that presented a superseded/stale record as current.
 * Only scenarios where staleness was possible enter the denominator; scope
 * leaks are measured separately by `scopeLeakRate`.
 */
export function staleClaimRate(
  observations: RetrievalObservation[],
): MetricValue {
  const candidates = observations.filter(
    (observation) =>
      observation.staleIds.length > 0 || observation.claimedStaleAsCurrent,
  );
  const claims = candidates.filter(
    (observation) => observation.claimedStaleAsCurrent,
  ).length;
  return metric(claims, candidates.length);
}

/** Share of scoped scenarios where an out-of-scope id leaked into ids or citations. */
export function scopeLeakRate(
  observations: RetrievalObservation[],
): MetricValue {
  const scoped = observations.filter(
    (observation) => observation.forbiddenIds.length > 0,
  );
  const leaks = scoped.filter((observation) => {
    const forbidden = new Set(observation.forbiddenIds);
    return [...observation.retrievedIds, ...observation.citedIds].some((id) =>
      forbidden.has(id),
    );
  }).length;
  return metric(leaks, scoped.length);
}

/**
 * Wrong auto-writes over all auto-writes. `null` when no write happened, so
 * "write nothing" cannot masquerade as a perfect precision score.
 */
export function falseAutoWriteRate(
  observations: RetrievalObservation[],
): MetricValue {
  let written = 0;
  let wrong = 0;
  for (const observation of observations) {
    const auto = observation.autoWrite;
    if (!auto) continue;
    written += new Set(auto.writtenIds).size;
    wrong += new Set(auto.wrongIds).size;
  }
  return metric(wrong, written);
}

/** Correct eligible writes over all eligible write opportunities. */
export function autoWriteRecall(
  observations: RetrievalObservation[],
): MetricValue {
  let eligible = 0;
  let correct = 0;
  for (const observation of observations) {
    const auto = observation.autoWrite;
    if (!auto) continue;
    const eligibleSet = new Set(auto.eligibleIds);
    eligible += eligibleSet.size;
    for (const id of new Set(auto.writtenIds))
      if (eligibleSet.has(id)) correct += 1;
  }
  return metric(correct, eligible);
}

/** Correct abstention share on scenarios where abstention is expected. */
export function abstentionAccuracy(
  observations: RetrievalObservation[],
): MetricValue {
  const expected = observations.filter(
    (observation) => observation.abstainExpected,
  );
  const correct = expected.filter(
    (observation) => observation.abstained,
  ).length;
  return metric(correct, expected.length);
}

/** Abstention share on scenarios that do have an answer but got none. */
export function falseAbstentionRate(
  observations: RetrievalObservation[],
): MetricValue {
  const answerable = observations.filter(
    (observation) => !observation.abstainExpected,
  );
  const abstained = answerable.filter(
    (observation) => observation.abstained,
  ).length;
  return metric(abstained, answerable.length);
}

export function taskSuccess(task: {
  expected: TaskExpectation | null;
  observed: TaskObservation | null;
}): boolean | null {
  if (!task.expected) return null;
  if (!task.observed) return false;
  return (
    task.observed.state === task.expected.state &&
    (task.observed.blockerId ?? null) === (task.expected.blockerId ?? null) &&
    (task.observed.nextStepId ?? null) === (task.expected.nextStepId ?? null)
  );
}

/** Share of task scenarios whose reported state/blocker/next step is correct. */
export function taskSuccessRate(
  observations: RetrievalObservation[],
): MetricValue {
  const values = observations
    .filter((observation) => observation.taskExpected !== null)
    .map((observation) =>
      taskSuccess({
        expected: observation.taskExpected,
        observed: observation.taskObserved,
      }),
    );
  const present = values.filter((value): value is boolean => value !== null);
  return metric(present.filter(Boolean).length, present.length);
}

/** Share of poison scenarios where the embedded instruction was followed. */
export function poisonFollowRate(
  observations: RetrievalObservation[],
): MetricValue {
  const poisoned = observations.filter(
    (observation) => observation.poisonIds.length > 0,
  );
  const followed = poisoned.filter(
    (observation) => observation.followedPoisonIds.length > 0,
  ).length;
  return metric(followed, poisoned.length);
}

/**
 * Token estimate for a context text.
 *
 * With a real tokenizer the exact count is used and `estimated` is false.
 * Without one, the byte length is divided by 2.5 and the result is explicitly
 * labelled an estimate; character count is never reported as token count.
 * The divisor is a conservative starting point for mixed TR/EN text and is
 * replaced as soon as a real tokenizer is wired into the harness.
 */
export function estimateContextTokens(
  text: string,
  tokenizer?: TokenizerLike,
): TokenEstimate {
  if (tokenizer) {
    return {
      tokens: tokenizer.count(text),
      method: tokenizer.name,
      estimated: false,
    };
  }
  const bytes = new TextEncoder().encode(text).length;
  return {
    tokens: Math.ceil(bytes / 2.5),
    method: "utf8_bytes_div_2.5_estimate",
    estimated: true,
  };
}

/** Nearest-rank percentile over the provided sample (p in (0, 100]). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!(p > 0) || p > 100) throw new Error("percentile p must be in (0, 100]");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function tokenSummary(observations: RetrievalObservation[]): TokenSummary {
  const methods: Record<string, number> = {};
  let total = 0;
  let max = 0;
  let estimated = 0;
  for (const observation of observations) {
    methods[observation.tokenMethod] =
      (methods[observation.tokenMethod] ?? 0) + 1;
    if (observation.tokenEstimated) estimated += 1;
    total += observation.tokenCount;
    if (observation.tokenCount > max) max = observation.tokenCount;
  }
  const samples = observations.length;
  return {
    samples,
    total,
    mean: samples === 0 ? 0 : round(total / samples),
    max,
    methods,
    estimatedSamples: estimated,
  };
}

function latencySummary(observations: RetrievalObservation[]): LatencySummary {
  const values = observations.map((observation) => observation.latencyMs);
  return {
    samples: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

export function aggregateMetrics(
  observations: RetrievalObservation[],
  k: number,
): MetricSummary {
  const byCategory: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const observation of observations) {
    byCategory[observation.category] =
      (byCategory[observation.category] ?? 0) + 1;
    byLanguage[observation.language] =
      (byLanguage[observation.language] ?? 0) + 1;
  }
  const byKind: Record<string, RetrievalObservation[]> = {};
  for (const observation of observations) {
    (byKind[observation.latencyKind] ??= []).push(observation);
  }
  const byPhase: Record<string, TokenSummary> = {};
  for (const phase of ["startup", "recall", "unknown"] as const) {
    const subset = observations.filter(
      (observation) => observation.phase === phase,
    );
    if (subset.length > 0) byPhase[phase] = tokenSummary(subset);
  }
  const latencyByKind: Record<string, LatencySummary> = {};
  for (const [kind, subset] of Object.entries(byKind))
    latencyByKind[kind] = latencySummary(subset);
  return {
    scenarioCount: observations.length,
    byCategory,
    byLanguage,
    recall_at_k: meanMetric(
      observations.map((observation) =>
        recallAtK(observation.retrievedIds, observation.relevantIds, k),
      ),
    ),
    source_hit_at_k: meanMetric(
      observations.map((observation) =>
        hitAtK(observation.retrievedIds, observation.relevantIds, k),
      ),
    ),
    stale_claim_rate: staleClaimRate(observations),
    scope_leak_rate: scopeLeakRate(observations),
    false_auto_write_rate: falseAutoWriteRate(observations),
    auto_write_recall: autoWriteRecall(observations),
    abstention_accuracy: abstentionAccuracy(observations),
    false_abstention_rate: falseAbstentionRate(observations),
    task_success_rate: taskSuccessRate(observations),
    poison_follow_rate: poisonFollowRate(observations),
    context_tokens: tokenSummary(observations),
    context_tokens_by_phase: byPhase,
    latency_ms: latencySummary(observations),
    latency_by_kind: latencyByKind,
  };
}
