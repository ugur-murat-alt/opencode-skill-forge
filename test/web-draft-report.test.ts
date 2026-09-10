import { describe, expect, test } from "bun:test";
import {
  buildReport,
  parseArgs,
  redact,
  REPORT_SCHEMA,
  verifyReport,
} from "../scripts/web-acceptance.mjs";

const token = "VvY4ICncxqGNZGFUqoq3T7tObddLA-iiOpPvv9lhQyQ";
const invite = "8Yq4sT1mJc0dWf7xkR2pB6vN3hZ5aL9eG1uS4iD7tQ0";

const args = (overrides: Record<string, unknown> = {}) => ({
  startedAt: "2026-09-10T10:00:00.000Z",
  finishedAt: "2026-09-10T10:05:00.000Z",
  versions: { app: "1.0.0", node: "v24.19.0", playwright: "1.63.0" },
  commitSha: "9f705a4deadbeef",
  runId: "34430006843",
  job: "web-acceptance",
  repository: "ugur-murat-alt/opencode-skill-forge",
  port: 38471,
  headed: false,
  shotsRoot: "shots",
  failureShots: [],
  results: [{ name: "login", ok: true, detail: "pairing code login" }],
  ...overrides,
});

describe("issue #30 acceptance report", () => {
  test("argument parsing supports valued and bare flags", () => {
    const parsed = parseArgs([
      "--port",
      "38471",
      "--report",
      "artifacts/report.json",
      "--headed",
      "--verify",
      "--expect-failure",
    ]);
    expect(parsed.args.get("--port")).toBe("38471");
    expect(parsed.args.get("--report")).toBe("artifacts/report.json");
    expect(parsed.flags.has("--headed")).toBe(true);
    expect(parsed.flags.has("--verify")).toBe(true);
    expect(parsed.flags.has("--expect-failure")).toBe(true);
  });

  test("redaction removes pairing codes, invite tokens and bearer values", () => {
    expect(redact(`pairing code ${token}`)).not.toContain(token);
    expect(redact(`invite token=${invite}`)).not.toContain(invite);
    expect(redact("Authorization: Bearer abcdef1234567890")).not.toContain(
      "abcdef1234567890",
    );
    // Scenario names and structured identifiers stay readable.
    expect(redact("draft-close-confirm open=true dialogs=1")).toBe(
      "draft-close-confirm open=true dialogs=1",
    );
    expect(redact("tenant 9b5d813f-28db-4e86-a8a4-9e58e17d4e71")).toContain(
      "9b5d813f-28db-4e86-a8a4-9e58e17d4e71",
    );
  });

  test("the report carries identity, timestamps, versions, counts and scenario ids", () => {
    const report = buildReport(args());
    expect(report.schema).toBe(REPORT_SCHEMA);
    expect(report.commit_sha).toBe("9f705a4deadbeef");
    expect(report.run_id).toBe("34430006843");
    expect(report.job).toBe("web-acceptance");
    expect(report.started_at).toBe("2026-09-10T10:00:00.000Z");
    expect(report.finished_at).toBe("2026-09-10T10:05:00.000Z");
    expect(report.versions.app).toBe("1.0.0");
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results.map((r: { name: string }) => r.name)).toEqual([
      "login",
    ]);
  });

  test("details are redacted before they reach the report or the log", () => {
    const report = buildReport(
      args({
        results: [
          {
            name: "pairing-code",
            ok: true,
            detail: `kabul kodu (5 dakika): ${token}`,
          },
          {
            name: "invite-create",
            ok: true,
            detail: `token uzunluğu ${invite.length}`,
          },
        ],
      }),
    );
    const text = JSON.stringify(report);
    expect(text).not.toContain(token);
    expect(text).not.toContain(invite);
    expect(report.results[0].detail).toContain("[redacted]");
  });

  test("a clean artifact parses, matches the stdout log and its identity", () => {
    const report = buildReport(args());
    const problems = verifyReport({
      report,
      logReport: report,
      expectedCommit: "9f705a4deadbeef",
      expectedRunId: "34430006843",
      expectedJob: "web-acceptance",
    });
    expect(problems).toEqual([]);
  });

  test("stale or mismatched artifacts are rejected", () => {
    const report = buildReport(args());
    expect(
      verifyReport({ report, logReport: report, expectedCommit: "other" }),
    ).toContain(`commit_sha ${report.commit_sha} != other`);
    expect(
      verifyReport({ report, logReport: report, expectedRunId: "999" }),
    ).toContain(`run_id ${report.run_id} != 999`);
    const truncated = buildReport(
      args({ results: [{ name: "login", ok: true }] }),
    );
    const problems = verifyReport({
      report,
      logReport: {
        ...truncated,
        total: 3,
        passed: 3,
        failed: 0,
        results: [
          { name: "login", ok: true },
          { name: "extra-a", ok: true },
          { name: "extra-b", ok: true },
        ],
      },
    });
    expect(problems.join("\n")).toContain("log/artifact counts differ");
  });

  test("log and artifact must expose the same scenario ids", () => {
    const report = buildReport(args());
    const logReport = {
      ...report,
      results: [{ name: "other-scenario", ok: true }],
    };
    const problems = verifyReport({ report, logReport });
    expect(problems.join("\n")).toContain("log/artifact scenario ids differ");
  });

  test("failure evidence is required when a failure is expected", () => {
    const report = buildReport(
      args({
        results: [{ name: "login", ok: false, detail: "injected" }],
        failureShots: [],
      }),
    );
    expect(report.failed).toBe(1);
    const green = verifyReport({ report, expectFailure: true });
    expect(green.join("\n")).toContain("no failure screenshot");
    const withShot = buildReport(
      args({
        results: [{ name: "login", ok: false, detail: "injected" }],
        failureShots: ["shots/failure-login-1.png"],
      }),
    );
    const missing = verifyReport({
      report: withShot,
      expectFailure: true,
      shotExists: () => false,
    });
    expect(missing.join("\n")).toContain(
      "failure shot missing: shots/failure-login-1.png",
    );
    expect(
      verifyReport({
        report: withShot,
        expectFailure: true,
        shotExists: () => true,
      }),
    ).toEqual([]);
    const noFailure = verifyReport({
      report: buildReport(args()),
      expectFailure: true,
    });
    expect(noFailure.join("\n")).toContain("expected a failure");
  });
});
