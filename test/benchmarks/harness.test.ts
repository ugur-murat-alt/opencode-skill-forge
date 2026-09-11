import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateThresholds,
  loadDataset,
  loadDatasetFile,
  runBenchmark,
  type BenchmarkDataset,
  type BenchmarkSystem,
  type ThresholdsFile,
} from "./harness.js";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/memory-benchmark");

function scenario(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    category: "old_new_decision",
    language: "tr",
    space: { type: "project", key: "p1" },
    asOf: "2026-09-11T00:00:00Z",
    query: "karar?",
    session: { id: "sess-1" },
    notes: [
      {
        id: "n1",
        title: "Karar",
        kind: "decision",
        state: "active",
        space: { type: "project", key: "p1" },
        pin: false,
        summary: "özet",
        body: "gövde",
        sections: [],
      },
    ],
    edges: [],
    expect: {
      retrieval: {
        relevant: ["n1"],
        stale: [],
        forbidden: [],
        quarantine: [],
        abstain: false,
      },
      answer: {},
      task: null,
      autoWrite: null,
    },
    ...overrides,
  };
}

function dataset(overrides: Record<string, unknown> = {}): BenchmarkDataset {
  return loadDataset({
    datasetId: "inline",
    split: "tuning",
    version: 1,
    language: "tr+en",
    synthetic: true,
    containsRealUserData: false,
    containsSecrets: false,
    metadata: {},
    budget: { startupMaxTokens: 1024, recallMaxTokens: 2048, maxCards: 8 },
    scenarios: [scenario()],
    ...overrides,
  });
}

function thresholds(overrides: Partial<ThresholdsFile> = {}): ThresholdsFile {
  return {
    id: "test-thresholds",
    version: 1,
    frozenAt: "2026-09-11",
    frozenBeforeMeasurement: true,
    measured: false,
    guarantee: false,
    status: "pre-registered-initial-target",
    source: "test",
    notes: [],
    budgets: { startupMaxTokens: 1024, recallMaxTokens: 2048, maxCards: 8 },
    latency: {
      warmLexicalGraphQueryP95Ms: 250,
      cachedStartupContextP95Ms: 100,
      percentileMethod: "nearest-rank",
      minimumSamples: 30,
      status: "initial-target-not-measured",
    },
    quality: [
      {
        metric: "recall_at_k",
        direction: "min",
        value: 0.8,
        status: "initial",
      },
      {
        metric: "stale_claim_rate",
        direction: "max",
        value: 0,
        status: "floor",
      },
    ],
    comparison: {},
    ...overrides,
  };
}

test("loadDataset accepts the shipped tuning fixture and rejects unsafe or broken data", async () => {
  const tuning = await loadDatasetFile(join(FIXTURE_DIR, "tuning.json"));
  expect(tuning.split).toBe("tuning");
  expect(tuning.scenarios.length).toBe(16);
  expect(tuning.containsRealUserData).toBe(false);

  expect(() => dataset({ containsRealUserData: true })).toThrow(
    "containsRealUserData",
  );
  expect(() => dataset({ synthetic: false })).toThrow("synthetic");
  expect(() => dataset({ containsSecrets: true })).toThrow("containsSecrets");
  expect(() => dataset({ scenarios: [scenario(), scenario()] })).toThrow(
    "duplicate scenario id",
  );
  expect(() =>
    dataset({
      scenarios: [
        scenario({
          edges: [{ from: "n1", to: "missing", predicate: "SUPPORTS" }],
        }),
      ],
    }),
  ).toThrow("references unknown note");
  expect(() =>
    dataset({
      scenarios: [
        scenario({
          expect: {
            retrieval: {
              relevant: ["n1"],
              stale: [],
              forbidden: ["n1"],
              abstain: false,
            },
            answer: {},
            task: null,
            autoWrite: null,
          },
        }),
      ],
    }),
  ).toThrow("relevant and forbidden overlap");
});

test("runBenchmark converts adapter responses into deterministic observations and a labelled report", async () => {
  const data = dataset({
    scenarios: [
      scenario({ id: "s1", category: "task_blocker_next_step" }),
      scenario({
        id: "s2",
        category: "irrelevant_query_abstention",
        notes: [],
        expect: {
          retrieval: {
            relevant: [],
            stale: [],
            forbidden: [],
            quarantine: [],
            abstain: true,
          },
          answer: {},
          task: null,
          autoWrite: null,
        },
      }),
    ],
  });
  const system: BenchmarkSystem = {
    name: "fake",
    retrieve: ({ scenario: current }) =>
      current.id === "s2"
        ? { retrievedIds: [], abstained: true, contextText: "" }
        : {
            retrievedIds: ["n1"],
            citedIds: ["n1"],
            abstained: false,
            contextText: "dört beş",
            phase: "recall",
            latencyKind: "warm_lexical_graph",
          },
  };
  let tick = 1000;
  const report = await runBenchmark({
    dataset: data,
    system,
    clock: () => (tick += 5),
    generatedAt: "2026-09-11T00:00:00Z",
  });
  expect(report.reportId).toBe("memory-benchmark-report");
  expect(report.system).toBe("fake");
  expect(report.k).toBe(8);
  expect(report.generatedAt).toBe("2026-09-11T00:00:00Z");
  expect(report.measurement.estimated).toBe(true);
  expect(report.measurement.tokenizer).toBeNull();
  expect(report.observations).toHaveLength(2);
  expect(report.observations[0]!.latencyMs).toBe(5);
  expect(report.observations[0]!.tokenMethod).toBe(
    "utf8_bytes_div_2.5_estimate",
  );
  expect(report.observations[0]!.tokenEstimated).toBe(true);
  expect(report.summary.recall_at_k.value).toBe(1);
  expect(report.summary.abstention_accuracy.value).toBe(1);
  expect(report.budgetUsage.maxCardsReturned).toBe(1);
  expect(report.budgetUsage.maxRecallTokens).toBeGreaterThan(0);
  expect(report.budgetUsage.maxStartupTokens).toBeNull();
});

test("runBenchmark labels real tokenizer counts as measured", async () => {
  const report = await runBenchmark({
    dataset: dataset(),
    system: {
      name: "fake",
      retrieve: () => ({
        retrievedIds: ["n1"],
        abstained: false,
        contextText: "x",
      }),
    },
    tokenizer: { name: "exact", count: () => 42 },
  });
  expect(report.measurement.estimated).toBe(false);
  expect(report.measurement.tokenizer).toBe("exact");
  expect(report.observations[0]!.tokenCount).toBe(42);
  expect(report.summary.context_tokens.estimatedSamples).toBe(0);
});

test("evaluateThresholds passes, fails and refuses to judge unmeasured values", async () => {
  const data = dataset({
    scenarios: [
      scenario({ id: "s1" }),
      scenario({
        id: "s2",
        notes: [],
        expect: {
          retrieval: {
            relevant: [],
            stale: [],
            forbidden: [],
            quarantine: [],
            abstain: false,
          },
          answer: {},
          task: null,
          autoWrite: null,
        },
      }),
    ],
  });
  const report = await runBenchmark({
    dataset: data,
    system: {
      name: "half",
      retrieve: ({ scenario: current }) =>
        current.id === "s1"
          ? { retrievedIds: ["n1"], abstained: false, contextText: "" }
          : { retrievedIds: ["n1"], abstained: false, contextText: "" },
    },
    clock: () => 0,
  });
  // s2 retrieves n1 although its note set is empty and it has no relevant id,
  // so recall keeps only s1 (1.0) while no stale sample exists.
  const results = evaluateThresholds(report, thresholds());
  const recall = results.find((result) => result.metric === "recall_at_k")!;
  expect(recall.status).toBe("pass");
  const stale = results.find((result) => result.metric === "stale_claim_rate")!;
  expect(stale.status).toBe("not-measured");
  for (const metric of [
    "warm_lexical_graph_query_p95_ms",
    "cached_startup_context_p95_ms",
    "startup_max_tokens",
    "recall_max_tokens",
  ]) {
    expect(results.find((result) => result.metric === metric)!.status).toBe(
      "not-measured",
    );
  }
  expect(
    results.find((result) => result.metric === "max_cards_returned")!.status,
  ).toBe("pass");

  const failing = evaluateThresholds(
    report,
    thresholds({
      quality: [
        { metric: "recall_at_k", direction: "min", value: 1.01, status: "t" },
      ],
    }),
  );
  expect(failing[0]!.status).toBe("fail");

  expect(() =>
    evaluateThresholds(
      report,
      thresholds({
        quality: [
          { metric: "made_up_metric", direction: "min", value: 1, status: "t" },
        ],
      }),
    ),
  ).toThrow("unknown quality metric");
});

test("evaluateThresholds uses nearest-rank p95 only after the minimum sample count", async () => {
  const data = dataset();
  let tick = 0;
  const report = await runBenchmark({
    dataset: data,
    system: {
      name: "latency",
      retrieve: () => ({
        retrievedIds: ["n1"],
        abstained: false,
        contextText: "",
        latencyKind: "warm_lexical_graph",
        phase: "recall",
        latencyMs: 10,
      }),
    },
    clock: () => (tick += 1),
  });
  const insufficient = evaluateThresholds(
    report,
    thresholds({
      quality: [],
      latency: {
        ...thresholds().latency,
        minimumSamples: 30,
      },
    }),
  );
  expect(insufficient[0]!.status).toBe("not-measured");
  const sufficient = evaluateThresholds(
    report,
    thresholds({
      quality: [],
      latency: { ...thresholds().latency, minimumSamples: 1 },
    }),
  );
  expect(sufficient[0]!.status).toBe("pass");
  expect(sufficient[0]!.actual).toBe(10);
});

test("loadDatasetFile round-trips the acceptance fixture without hidden real data", async () => {
  const acceptance = await loadDatasetFile(
    join(FIXTURE_DIR, "acceptance.json"),
  );
  expect(acceptance.split).toBe("acceptance");
  expect(acceptance.scenarios).toHaveLength(16);
  const raw = await readFile(join(FIXTURE_DIR, "acceptance.json"), "utf8");
  expect(raw).not.toContain("PRIVATE KEY");
});
