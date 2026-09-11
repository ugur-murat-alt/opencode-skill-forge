import { test, expect } from "bun:test";
import {
  abstentionAccuracy,
  aggregateMetrics,
  autoWriteRecall,
  estimateContextTokens,
  falseAbstentionRate,
  falseAutoWriteRate,
  hitAtK,
  percentile,
  poisonFollowRate,
  recallAtK,
  scopeLeakRate,
  staleClaimRate,
  taskSuccess,
  taskSuccessRate,
  type RetrievalObservation,
} from "./metrics.js";

function obs(partial: Partial<RetrievalObservation>): RetrievalObservation {
  const contextText = partial.contextText ?? "";
  const estimate = estimateContextTokens(contextText);
  return {
    scenarioId: partial.scenarioId ?? "s",
    category: partial.category ?? "cat",
    language: partial.language ?? "tr",
    retrievedIds: partial.retrievedIds ?? [],
    citedIds: partial.citedIds ?? [],
    relevantIds: partial.relevantIds ?? [],
    staleIds: partial.staleIds ?? [],
    forbiddenIds: partial.forbiddenIds ?? [],
    poisonIds: partial.poisonIds ?? [],
    abstained: partial.abstained ?? false,
    abstainExpected: partial.abstainExpected ?? false,
    claimedStaleAsCurrent: partial.claimedStaleAsCurrent ?? false,
    followedPoisonIds: partial.followedPoisonIds ?? [],
    autoWrite: partial.autoWrite ?? null,
    taskExpected: partial.taskExpected ?? null,
    taskObserved: partial.taskObserved ?? null,
    latencyMs: partial.latencyMs ?? 0,
    latencyKind: partial.latencyKind ?? "warm_lexical_graph",
    phase: partial.phase ?? "recall",
    contextText,
    tokenCount: partial.tokenCount ?? estimate.tokens,
    tokenMethod: partial.tokenMethod ?? estimate.method,
    tokenEstimated: partial.tokenEstimated ?? estimate.estimated,
  };
}

test("recallAtK and hitAtK are k-bounded and N/A without expected items", () => {
  expect(recallAtK(["a", "b", "c"], ["b", "d"], 2)).toBe(0.5);
  expect(recallAtK(["c", "b"], ["b", "c"], 2)).toBe(1);
  expect(recallAtK(["c"], ["b"], 2)).toBe(0);
  expect(recallAtK(["b"], [], 2)).toBeNull();
  expect(hitAtK(["x", "b"], ["b"], 1)).toBe(0);
  expect(hitAtK(["x", "b"], ["b"], 2)).toBe(1);
  expect(hitAtK(["x"], [], 2)).toBeNull();
  // Duplicate retrievals must not inflate recall or the k-budget.
  expect(recallAtK(["b", "b", "c"], ["b", "c"], 2)).toBe(0.5);
});

test("staleClaimRate only counts scenarios where staleness was possible", () => {
  const summary = staleClaimRate([
    obs({ staleIds: ["old"], claimedStaleAsCurrent: true }),
    obs({ staleIds: ["old2"], claimedStaleAsCurrent: false }),
    obs({ relevantIds: ["fresh"] }),
    // Scope-only scenarios belong to scope_leak_rate, not here.
    obs({ forbiddenIds: ["secret"] }),
  ]);
  expect(summary.value).toBe(0.5);
  expect(summary.denominator).toBe(2);
  expect(staleClaimRate([obs({ relevantIds: ["fresh"] })]).value).toBeNull();
});

test("scopeLeakRate detects retrievals and citations from forbidden scope", () => {
  const summary = scopeLeakRate([
    obs({ forbiddenIds: ["secret"], retrievedIds: ["secret"] }),
    obs({ forbiddenIds: ["secret2"], citedIds: ["secret2"] }),
    obs({ forbiddenIds: ["secret3"], retrievedIds: ["ok"] }),
  ]);
  expect(summary.value).toBeCloseTo(2 / 3, 6);
  expect(summary.denominator).toBe(3);
  expect(scopeLeakRate([obs({})]).value).toBeNull();
});

test("auto-write metrics do not treat 'write nothing' as perfect precision", () => {
  expect(falseAutoWriteRate([obs({})]).value).toBeNull();
  expect(autoWriteRecall([obs({})]).value).toBeNull();
  const rate = falseAutoWriteRate([
    obs({
      autoWrite: {
        eligibleIds: ["a", "b"],
        writtenIds: ["a", "bad"],
        wrongIds: ["bad"],
      },
    }),
  ]);
  expect(rate.numerator).toBe(1);
  expect(rate.denominator).toBe(2);
  expect(rate.value).toBe(0.5);
  const recall = autoWriteRecall([
    obs({
      autoWrite: {
        eligibleIds: ["a", "b"],
        writtenIds: ["a", "bad"],
        wrongIds: ["bad"],
      },
    }),
  ]);
  expect(recall.numerator).toBe(1);
  expect(recall.denominator).toBe(2);
  expect(recall.value).toBe(0.5);
});

test("abstention metrics separate expected abstention from lost answers", () => {
  const observations = [
    obs({ abstainExpected: true, abstained: true }),
    obs({ abstainExpected: true, abstained: false }),
    obs({ abstainExpected: false, abstained: true }),
    obs({ abstainExpected: false, abstained: false }),
  ];
  expect(abstentionAccuracy(observations).value).toBe(0.5);
  expect(abstentionAccuracy(observations).denominator).toBe(2);
  expect(falseAbstentionRate(observations).value).toBe(0.5);
  expect(falseAbstentionRate(observations).denominator).toBe(2);
});

test("taskSuccessRate requires state, blocker and next step to match", () => {
  const expected = {
    taskId: "t1",
    state: "blocked",
    blockerId: "b1",
    nextStepId: "n1",
  };
  expect(
    taskSuccess({
      expected,
      observed: { state: "blocked", blockerId: "b1", nextStepId: "n1" },
    }),
  ).toBe(true);
  expect(
    taskSuccess({
      expected,
      observed: { state: "blocked", blockerId: "b1", nextStepId: null },
    }),
  ).toBe(false);
  expect(taskSuccess({ expected, observed: null })).toBe(false);
  expect(taskSuccess({ expected: null, observed: null })).toBeNull();
  const summary = taskSuccessRate([
    obs({
      taskExpected: expected,
      taskObserved: { state: "blocked", blockerId: "b1", nextStepId: "n1" },
    }),
    obs({
      taskExpected: expected,
      taskObserved: { state: "doing", blockerId: "b1", nextStepId: "n1" },
    }),
    obs({}),
  ]);
  expect(summary.value).toBe(0.5);
  expect(summary.denominator).toBe(2);
});

test("poisonFollowRate only counts scenarios that contain a poisoned record", () => {
  expect(poisonFollowRate([obs({})]).value).toBeNull();
  const summary = poisonFollowRate([
    obs({ poisonIds: ["p"], followedPoisonIds: ["p"] }),
    obs({ poisonIds: ["p2"], followedPoisonIds: [] }),
  ]);
  expect(summary.value).toBe(0.5);
  expect(summary.denominator).toBe(2);
});

test("estimateContextTokens uses a tokenizer when present and otherwise labels an estimate", () => {
  const text = "Veritabanı kararı: üretimde PostgreSQL.";
  const exact = estimateContextTokens(text, {
    name: "fake-tokenizer",
    count: () => 7,
  });
  expect(exact).toEqual({
    tokens: 7,
    method: "fake-tokenizer",
    estimated: false,
  });

  const estimated = estimateContextTokens(text);
  expect(estimated.estimated).toBe(true);
  expect(estimated.method).toBe("utf8_bytes_div_2.5_estimate");
  const bytes = new TextEncoder().encode(text).length;
  expect(estimated.tokens).toBe(Math.ceil(bytes / 2.5));
  // Character count is never reported as a token count.
  expect(estimated.tokens).not.toBe(text.length);
});

test("percentile uses deterministic nearest-rank and rejects invalid input", () => {
  const values = [5, 1, 4, 2, 3];
  expect(percentile(values, 50)).toBe(3);
  expect(percentile(values, 95)).toBe(5);
  expect(percentile(values, 100)).toBe(5);
  expect(percentile([], 95)).toBeNull();
  expect(percentile([10], 95)).toBe(10);
  expect(() => percentile(values, 0)).toThrow();
  expect(() => percentile(values, 101)).toThrow();
  const sorted = [1, 2, 3, 4, 5];
  expect(percentile([...values].reverse(), 95)).toBe(percentile(sorted, 95));
});

test("aggregateMetrics composes per-metric numerators, denominators and phase/latency groups", () => {
  const observations = [
    obs({
      scenarioId: "a",
      relevantIds: ["r1", "r2"],
      retrievedIds: ["r1", "x"],
      staleIds: ["s1"],
      claimedStaleAsCurrent: false,
      latencyMs: 10,
      latencyKind: "warm_lexical_graph",
      phase: "recall",
      contextText: "bir iki üç",
    }),
    obs({
      scenarioId: "b",
      category: "other",
      language: "en",
      relevantIds: ["r3"],
      retrievedIds: ["r3"],
      claimedStaleAsCurrent: true,
      staleIds: ["s2"],
      latencyMs: 30,
      latencyKind: "cached_startup",
      phase: "startup",
      abstainExpected: false,
    }),
  ];
  const summary = aggregateMetrics(observations, 8);
  expect(summary.scenarioCount).toBe(2);
  expect(summary.byCategory).toEqual({ cat: 1, other: 1 });
  expect(summary.byLanguage).toEqual({ tr: 1, en: 1 });
  expect(summary.recall_at_k.value).toBeCloseTo(0.75, 6);
  expect(summary.recall_at_k.denominator).toBe(2);
  expect(summary.source_hit_at_k.value).toBe(1);
  expect(summary.stale_claim_rate.value).toBe(0.5);
  expect(summary.latency_ms.p50).toBe(10);
  expect(summary.latency_ms.p95).toBe(30);
  expect(summary.latency_by_kind["warm_lexical_graph"]!.p95).toBe(10);
  expect(summary.latency_by_kind["cached_startup"]!.p95).toBe(30);
  expect(summary.context_tokens_by_phase["startup"]!.samples).toBe(1);
  expect(summary.context_tokens_by_phase["recall"]!.samples).toBe(1);
  expect(summary.context_tokens.estimatedSamples).toBe(2);
});

test("metric math is deterministic for the same input", () => {
  const observations = [
    obs({ relevantIds: ["a"], retrievedIds: ["a"], latencyMs: 7 }),
    obs({ relevantIds: ["b"], retrievedIds: [], latencyMs: 9 }),
  ];
  const first = JSON.stringify(aggregateMetrics(observations, 8));
  const second = JSON.stringify(aggregateMetrics(observations, 8));
  expect(first).toBe(second);
});
