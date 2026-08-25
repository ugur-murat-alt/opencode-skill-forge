import { expect, test } from "bun:test";
import { startRequestPoller } from "../../src/prompt-editor/index.js";
import type { PromptEditorRequest } from "../../src/prompt-editor/live.js";
import { EditorRegistry } from "../../src/prompt-editor/runner.js";

const request = (
  kind: PromptEditorRequest["kind"],
  revision: number,
  ts: number,
): PromptEditorRequest => ({
  protocolVersion: 2,
  kind,
  sessionID: "ses_1",
  messageID: "msg_1",
  gateID: "gate-test-1",
  revision,
  ts,
});

test("serialized polls preserve decision order", async () => {
  const registry = new EditorRegistry();
  const batches = [[request("re-evaluate", 1, 1)], [request("accept", 2, 2)]];
  const processed: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const poller = startRequestPoller(() => undefined, {
    pollMs: 60_000,
    initialDelayMs: 60_000,
    read: () => batches.shift() ?? [],
    process: async (item) => {
      processed.push(`${item.kind}:${item.revision}:start`);
      if (item.kind === "re-evaluate") {
        started();
        await firstGate;
      }
      processed.push(`${item.kind}:${item.revision}:end`);
    },
  });

  const first = poller.poll();
  await firstStarted;
  const second = poller.poll();
  release();
  await Promise.all([first, second]);
  await poller.stop();

  expect(processed).toEqual([
    "re-evaluate:1:start",
    "re-evaluate:1:end",
    "accept:2:start",
    "accept:2:end",
  ]);
  registry.dispose();
});

test("failed request processing is not acknowledged and can be retried", async () => {
  const registry = new EditorRegistry();
  const item = request("accept", 1, 1);
  let attempts = 0;
  const acknowledged: PromptEditorRequest[] = [];
  const poller = startRequestPoller(() => undefined, {
    pollMs: 60_000,
    initialDelayMs: 60_000,
    read: () => [item],
    process: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
    },
    acknowledge: (processed) => {
      acknowledged.push(processed);
      return true;
    },
  });
  await poller.poll();
  expect(acknowledged).toHaveLength(0);
  await poller.poll();
  expect(attempts).toBe(2);
  expect(acknowledged).toEqual([item]);
  await poller.stop();
  registry.dispose();
});

test("acknowledgement failure leaves a processed request retryable", async () => {
  const registry = new EditorRegistry();
  const item = request("accept", 1, 1);
  let processed = 0;
  let acknowledgements = 0;
  const poller = startRequestPoller(() => undefined, {
    pollMs: 60_000,
    initialDelayMs: 60_000,
    read: () => [item],
    process: async () => {
      processed += 1;
    },
    acknowledge: () => {
      acknowledgements += 1;
      return acknowledgements > 1;
    },
  });

  await poller.poll();
  await poller.poll();
  expect(processed).toBe(2);
  expect(acknowledgements).toBe(2);
  await poller.stop();
  registry.dispose();
});
