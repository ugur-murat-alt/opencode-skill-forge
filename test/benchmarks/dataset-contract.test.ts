import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  QUALITY_METRIC_KEYS,
  evaluateThresholds,
  loadDatasetFile,
  runBenchmark,
  type BenchmarkDataset,
  type BenchmarkScenario,
  type BenchmarkSystem,
  type ThresholdsFile,
} from "./harness.js";
import { computeFixtureMetadata } from "../fixtures/memory-benchmark/synthetic.js";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/memory-benchmark");
const CATEGORIES = [
  "old_new_decision",
  "same_name_different_scope",
  "temporal_information",
  "multi_session_continuity",
  "task_blocker_next_step",
  "irrelevant_query_abstention",
  "contradiction",
  "memory_poisoning",
];

async function splits(): Promise<{
  tuning: BenchmarkDataset;
  acceptance: BenchmarkDataset;
}> {
  return {
    tuning: await loadDatasetFile(join(FIXTURE_DIR, "tuning.json")),
    acceptance: await loadDatasetFile(join(FIXTURE_DIR, "acceptance.json")),
  };
}

/** Answers exactly what each scenario declares, so every quality metric must pass. */
function oracleSystem(): BenchmarkSystem {
  return {
    name: "oracle-fixture",
    retrieve: ({ scenario }: { scenario: BenchmarkScenario }) => ({
      retrievedIds: scenario.expect.retrieval.relevant,
      citedIds:
        scenario.expect.answer.mustCite ?? scenario.expect.retrieval.relevant,
      abstained: scenario.expect.retrieval.abstain,
      claimedStaleAsCurrent: false,
      followedPoisonIds: [],
      autoWrite: scenario.expect.autoWrite
        ? {
            eligibleIds: scenario.expect.autoWrite.eligible,
            writtenIds: scenario.expect.autoWrite.eligible,
            wrongIds: [],
          }
        : null,
      task: scenario.expect.task
        ? {
            state: scenario.expect.task.state,
            blockerId: scenario.expect.task.blockerId,
            nextStepId: scenario.expect.task.nextStepId,
          }
        : null,
      contextText: "",
      latencyMs: 1,
      latencyKind: "warm_lexical_graph",
      phase: "recall",
    }),
  };
}

test("both splits cover every category with at least one TR and one EN scenario", async () => {
  const { tuning, acceptance } = await splits();
  for (const dataset of [tuning, acceptance]) {
    for (const category of CATEGORIES) {
      const languages = dataset.scenarios
        .filter((scenario) => scenario.category === category)
        .map((scenario) => scenario.language);
      expect(languages, `${dataset.split}/${category}`).toContain("tr");
      expect(languages, `${dataset.split}/${category}`).toContain("en");
    }
    expect(new Set(dataset.scenarios.map((scenario) => scenario.id)).size).toBe(
      dataset.scenarios.length,
    );
  }
});

test("tuning and acceptance splits do not share scenario or note ids", async () => {
  const { tuning, acceptance } = await splits();
  const tuningScenarios = new Set(
    tuning.scenarios.map((scenario) => scenario.id),
  );
  const tuningNotes = new Set(
    tuning.scenarios.flatMap((scenario) =>
      scenario.notes.map((note) => note.id),
    ),
  );
  for (const scenario of acceptance.scenarios)
    expect(tuningScenarios.has(scenario.id)).toBe(false);
  for (const note of acceptance.scenarios.flatMap((scenario) => scenario.notes))
    expect(tuningNotes.has(note.id)).toBe(false);
});

test("declared metadata matches the fixtures recomputed from source", async () => {
  for (const file of ["tuning.json", "acceptance.json"]) {
    const raw = JSON.parse(await readFile(join(FIXTURE_DIR, file), "utf8")) as {
      scenarios: unknown[];
      metadata: unknown;
    };
    const computed = computeFixtureMetadata({
      scenarios: raw.scenarios as never,
    });
    expect(raw.metadata, file).toEqual(computed);
  }
});

test("thresholds were frozen before measurement and cover every quality metric", async () => {
  const thresholds = JSON.parse(
    await readFile(join(FIXTURE_DIR, "thresholds.json"), "utf8"),
  ) as ThresholdsFile;
  expect(thresholds.version).toBeGreaterThanOrEqual(1);
  expect(thresholds.frozenBeforeMeasurement).toBe(true);
  expect(thresholds.measured).toBe(false);
  expect(thresholds.guarantee).toBe(false);
  expect(thresholds.budgets).toMatchObject({
    startupMaxTokens: 1024,
    recallMaxTokens: 2048,
    maxCards: 8,
  });
  expect(thresholds.latency.warmLexicalGraphQueryP95Ms).toBe(250);
  expect(thresholds.latency.cachedStartupContextP95Ms).toBe(100);
  const metrics = thresholds.quality.map((entry) => entry.metric);
  expect(new Set(metrics).size).toBe(metrics.length);
  for (const metric of QUALITY_METRIC_KEYS) expect(metrics).toContain(metric);
  for (const entry of thresholds.quality) {
    expect(QUALITY_METRIC_KEYS).toContain(entry.metric as never);
    if (entry.status.startsWith("zero-tolerance")) expect(entry.value).toBe(0);
  }
});

test("fixtures contain no real-looking secrets, credentials or transcripts", async () => {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bsk-[A-Za-z0-9]{16,}\b/,
    /\b(password|passwd|secret|token)\s*[:=]\s*["'][^"']{8,}["']/i,
    /\bpostgres(?:ql)?:\/\/[^\s"']+:[^\s"'@]+@/,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  ];
  for (const file of [
    "tuning.json",
    "acceptance.json",
    "thresholds.json",
    "schema.json",
    "synthetic.ts",
    "README.md",
  ]) {
    const raw = await readFile(join(FIXTURE_DIR, file), "utf8");
    for (const pattern of patterns)
      expect(raw, `${file} matches ${pattern}`).not.toMatch(pattern);
  }
});

test("an oracle adapter reaches every quality target, proving fixtures and metrics agree", async () => {
  const { tuning, acceptance } = await splits();
  const oracle = oracleSystem();
  for (const dataset of [tuning, acceptance]) {
    const report = await runBenchmark({
      dataset,
      system: oracle,
      clock: () => 0,
      generatedAt: "2026-09-11T00:00:00Z",
    });
    expect(report.summary.recall_at_k.value, dataset.split).toBe(1);
    expect(report.summary.source_hit_at_k.value).toBe(1);
    expect(report.summary.stale_claim_rate.value).toBe(0);
    expect(report.summary.scope_leak_rate.value).toBe(0);
    expect(report.summary.false_auto_write_rate.value).toBe(0);
    expect(report.summary.auto_write_recall.value).toBe(1);
    expect(report.summary.abstention_accuracy.value).toBe(1);
    expect(report.summary.false_abstention_rate.value).toBe(0);
    expect(report.summary.task_success_rate.value).toBe(1);
    expect(report.summary.poison_follow_rate.value).toBe(0);
    // Zero-tolerance denominators must exist, otherwise "0" would be empty.
    expect(report.summary.stale_claim_rate.denominator).toBeGreaterThan(0);
    expect(report.summary.scope_leak_rate.denominator).toBeGreaterThan(0);
    expect(report.summary.poison_follow_rate.denominator).toBeGreaterThan(0);
  }
});

test("thresholds evaluate a real oracle report without silent passes", async () => {
  const { tuning } = await splits();
  const thresholds = JSON.parse(
    await readFile(join(FIXTURE_DIR, "thresholds.json"), "utf8"),
  ) as ThresholdsFile;
  const report = await runBenchmark({
    dataset: tuning,
    system: oracleSystem(),
    clock: () => 0,
    generatedAt: "2026-09-11T00:00:00Z",
  });
  const results = evaluateThresholds(report, thresholds);
  const byMetric = new Map(results.map((result) => [result.metric, result]));
  // Every metric that had a measured sample must pass for the oracle; nothing
  // may silently pass without one.
  for (const result of results) {
    if (result.status !== "not-measured")
      expect(result.status, result.metric).toBe("pass");
  }
  // Latency and startup budget have no measured samples in this run, so the
  // gate must say so instead of passing.
  expect(byMetric.get("warm_lexical_graph_query_p95_ms")!.status).toBe(
    "not-measured",
  );
  expect(byMetric.get("cached_startup_context_p95_ms")!.status).toBe(
    "not-measured",
  );
  expect(byMetric.get("startup_max_tokens")!.status).toBe("not-measured");
});
