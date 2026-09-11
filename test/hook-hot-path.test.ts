import { test, expect } from "bun:test";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientHook } from "../src/clients/hook.js";
import { acceptHookCapture } from "../src/clients/hook-spool.js";
import { writeInstallationBinding } from "../src/clients/hook-binding.js";
import { startHookFixture } from "./hook-fixtures.js";

/**
 * Local (non-native) hot-path evidence for issue #38:
 *  - the capture path is pure local IO: no runner/jobs/provider/model import,
 *  - no LLM call, no `ensureDaemon` on the spool path,
 *  - a warm capture accept stays far below the client timeout.
 * These are fixture measurements; native client latency is still untested.
 */

const CAPTURE_FILES = [
  "src/clients/hook-contract.ts",
  "src/clients/hook-spool.ts",
  "src/clients/hook-binding.ts",
  "src/clients/worktree-binding.ts",
  "src/clients/context-client.ts",
  "src/clients/context-state.ts",
];

test("capture modules never import a runner, provider or model layer", async () => {
  const offenders: string[] = [];
  for (const file of CAPTURE_FILES) {
    const source = await readFile(join(import.meta.dir, "..", file), "utf8");
    for (const pattern of [
      /pi-ai|pi-agent-core/,
      /from "\.\.\/(runner|jobs|mcp|application\/forge)/,
      /from "\.\.\/cli\/daemon/,
    ])
      if (pattern.test(source)) offenders.push(`${file} :: ${pattern}`);
  }
  expect(offenders).toEqual([]);
});

test("a warm capture accept stays inside the local hot-path budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-hotpath-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    const input = {
      dataDir,
      installationId: "c".repeat(64),
      projectRef: "project-ref",
      client: "claude" as const,
      event: "Stop",
      sessionId: "session-hot",
      turnRef: "turn-hot",
      worktreeKey: "worktree-hot",
      sourceKind: "claude-stop-hook",
      kind: "session",
      content: "# Checkpoint\n\nhot path",
    };
    await acceptHookCapture(input); // warm-up (may run migrations once)
    const samples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const start = performance.now();
      await acceptHookCapture({ ...input, sessionId: `session-${index}` });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    expect(median).toBeLessThan(250);
    expect(samples.at(-1)!).toBeLessThan(1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a full warm Stop callback stays below the client timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-hotpath-stop-"));
  const project = join(root, "project");
  const dataDir = join(root, "data");
  await mkdir(project, { recursive: true });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeInstallationBinding(dataDir, {
    client: "codex",
    projectRef: "project-ref",
    projectRoot: project,
  });
  const fixture = await startHookFixture(dataDir);
  try {
    const payload = {
      hook_event_name: "Stop",
      session_id: "session-stop",
      turn_id: "turn-1",
      last_assistant_message: "Warm callback.",
      cwd: project,
    };
    await clientHook(
      fixture.config,
      "unused-entry",
      "codex",
      "project-ref",
      payload,
      { deliver: false },
    ); // warm-up
    const start = performance.now();
    await clientHook(
      fixture.config,
      "unused-entry",
      "codex",
      "project-ref",
      { ...payload, turn_id: "turn-2" },
      { deliver: false },
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
