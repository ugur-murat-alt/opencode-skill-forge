import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
test("Node benchmark diagnostics bound each window and release observers", async () => {
  const moduleUrl = pathToFileURL(
    resolve("scripts/benchmark-runtime.mjs"),
  ).href;
  const { stdout } = await exec(
    "node",
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
    import {runtimeSampler} from ${JSON.stringify(moduleUrl)};
    const sampler=runtimeSampler();
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    await sleep(60);
    global.gc();
    await sleep(60);
    const first=sampler.sample();
    const reset=sampler.sample();
    sampler.close();
    console.log(JSON.stringify({first,reset}));
  `,
    ],
    { timeout: 5000 },
  );
  const { first, reset } = JSON.parse(stdout);
  expect(first.event_loop_delay.observations).toBeGreaterThan(0);
  expect(first.event_loop_delay.mean_ms).toBeGreaterThan(0);
  expect(first.gc.count).toBeGreaterThan(0);
  expect(first.gc.duration_ms).toBeGreaterThan(0);
  expect(first.event_loop_utilization).toBeGreaterThanOrEqual(0);
  expect(first.event_loop_utilization).toBeLessThanOrEqual(1);
  expect(first.cpu_user_ms).toBeGreaterThanOrEqual(0);
  expect(reset.event_loop_delay.observations).toBe(0);
  expect(reset.event_loop_delay.mean_ms).toBeNull();
  expect(reset.event_loop_delay.p95_ms).toBeNull();
  expect(reset.gc).toEqual({ count: 0, duration_ms: 0, max_duration_ms: 0 });
});
