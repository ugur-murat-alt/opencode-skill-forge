import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/storage/database.js";
import { IdentityService } from "../../src/application/identity.js";
import { vaultRoot } from "../../src/memory/paths.js";
import {
  evaluateThresholds,
  loadDatasetFile,
  runBenchmark,
  type ThresholdsFile,
} from "./harness.js";
import { MemoryBenchmarkSystem } from "./memory-system.js";

/**
 * Issue #36 (M03) benchmark acceptance — real run.
 *
 * The acceptance split is held out: thresholds in `thresholds.json` were
 * frozen before measurement and are never adjusted after seeing results.
 * Auto-write is intentionally disabled in M03, so its recall/false-write
 * metrics stay `not-measured` (no write path exists) while every measured
 * quality and budget threshold must pass.
 */
test("#36 benchmark acceptance: real corpus meets the frozen quality and budget thresholds", async () => {
  const fixtureDir = join(
    import.meta.dir,
    "..",
    "fixtures",
    "memory-benchmark",
  );
  const acceptance = await loadDatasetFile(join(fixtureDir, "acceptance.json"));
  const thresholds = JSON.parse(
    await Bun.file(join(fixtureDir, "thresholds.json")).text(),
  ) as ThresholdsFile;
  const root = await mkdtemp(join(tmpdir(), "forge-m03-acceptance-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const system = new MemoryBenchmarkSystem({
      db: storage.db,
      identities,
      vaultRoot: vaultRoot(root),
    });
    const report = await runBenchmark({
      dataset: acceptance,
      system,
      generatedAt: acceptance.datasetId,
    });
    const results = evaluateThresholds(report, thresholds);
    console.log(
      `M03-BENCH-ACCEPT ${JSON.stringify({
        system: report.system,
        k: report.k,
        budgetUsage: report.budgetUsage,
        contexts: report.summary.context_tokens,
        latency: report.summary.latency_ms,
        quality: Object.fromEntries(
          [
            "recall_at_k",
            "source_hit_at_k",
            "stale_claim_rate",
            "scope_leak_rate",
            "abstention_accuracy",
            "false_abstention_rate",
            "task_success_rate",
            "poison_follow_rate",
            "false_auto_write_rate",
            "auto_write_recall",
          ].map((key) => [
            key,
            (report.summary as unknown as Record<string, unknown>)[key],
          ]),
        ),
        thresholds: results,
      })}`,
    );
    // Donmuş eşikler: hiçbir ölçüm "fail" olmamalı.
    const failed = results.filter((result) => result.status === "fail");
    expect(failed).toEqual([]);
    // Kritik kalite metrikleri gerçekten ölçülmüş ve geçmiş olmalı.
    const measured = [
      "recall_at_k",
      "source_hit_at_k",
      "stale_claim_rate",
      "scope_leak_rate",
      "abstention_accuracy",
      "task_success_rate",
      "poison_follow_rate",
    ];
    for (const metric of measured) {
      const result = results.find((entry) => entry.metric === metric);
      expect(result, metric).toBeDefined();
      expect(result!.status, metric).toBe("pass");
      expect(result!.actual, metric).not.toBeNull();
    }
    // İki bütçe de gerçek örneklerle ölçülür ve eşiğin altında kalır.
    for (const metric of ["startup_max_tokens", "recall_max_tokens"]) {
      const result = results.find((entry) => entry.metric === metric);
      expect(result, metric).toBeDefined();
      expect(result!.status, metric).toBe("pass");
    }
    // Otomatik yazım kapalı: recall/false-write "not-measured", asla "pass"
    // diye sunulmaz ve eşik düşürülmez.
    for (const metric of ["auto_write_recall", "false_auto_write_rate"]) {
      const result = results.find((entry) => entry.metric === metric);
      expect(result!.status, metric).toBe("not-measured");
    }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300000);

test("#36 tuning split also runs without any threshold failure (development split)", async () => {
  const fixtureDir = join(
    import.meta.dir,
    "..",
    "fixtures",
    "memory-benchmark",
  );
  const tuning = await loadDatasetFile(join(fixtureDir, "tuning.json"));
  const thresholds = JSON.parse(
    await Bun.file(join(fixtureDir, "thresholds.json")).text(),
  ) as ThresholdsFile;
  const root = await mkdtemp(join(tmpdir(), "forge-m03-tuning-"));
  const storage = await openDatabase({ dataDir: root });
  try {
    const identities = new IdentityService(storage.db);
    const system = new MemoryBenchmarkSystem({
      db: storage.db,
      identities,
      vaultRoot: vaultRoot(root),
    });
    const report = await runBenchmark({ dataset: tuning, system });
    const results = evaluateThresholds(report, thresholds);
    console.log(
      `M03-BENCH-TUNING ${JSON.stringify({
        quality: report.summary.recall_at_k,
        budgets: report.budgetUsage,
        failed: results.filter((result) => result.status === "fail"),
      })}`,
    );
    expect(results.filter((result) => result.status === "fail")).toEqual([]);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300000);
