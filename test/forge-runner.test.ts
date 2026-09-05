import { expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  Type,
  type Model,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { ForgeRunner } from "../src/runner/forge-runner.js";
const model: Model<"openai-completions"> = {
  id: "fixture",
  name: "fixture",
  provider: "fixture",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1000,
};
const base = {
  profile: "skill_evolve" as const,
  sessionId: "isolated-test",
  model,
  systemPrompt: "Test",
  input: "Test",
  deadlineMs: 500,
  maxCalls: 6,
  maxTokens: 4096,
  maxCostMicros: 1000,
};
function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      reasoning: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
test("Pi termination closes mixed batches and prevents writes after finalize without another call", async () => {
  let writes = 0,
    calls = 0;
  const result = await new ForgeRunner().run({
    ...base,
    tools: [
      {
        name: "finalize",
        label: "Finalize",
        description: "Finish",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "no-op" }],
          details: {},
          terminate: true,
        }),
      },
      {
        name: "write",
        label: "Write",
        description: "Write",
        parameters: Type.Object({}),
        execute: async () => {
          writes++;
          return { content: [{ type: "text", text: "written" }], details: {} };
        },
      },
    ],
    stream: () => {
      calls++;
      const s = createAssistantMessageEventStream();
      s.push({
        type: "done",
        reason: "toolUse",
        message: message([
          { type: "toolCall", id: "f", name: "finalize", arguments: {} },
          { type: "toolCall", id: "w", name: "write", arguments: {} },
        ]),
      });
      return s;
    },
  });
  expect(result.finalized).toBe(true);
  expect(calls).toBe(1);
  expect(writes).toBe(0);
  expect(result.usage?.totalTokens).toBe(17);
  expect(result.usage?.output).toBe(5);
});
test("call budget bounds non-terminating model loops", async () => {
  const result = await new ForgeRunner().run({
    ...base,
    maxCalls: 2,
    tools: [
      {
        name: "read",
        label: "Read",
        description: "Read",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "data" }],
          details: {},
        }),
      },
    ],
    stream: () => {
      const s = createAssistantMessageEventStream();
      s.push({
        type: "done",
        reason: "toolUse",
        message: message([
          {
            type: "toolCall",
            id: crypto.randomUUID(),
            name: "read",
            arguments: {},
          },
        ]),
      });
      return s;
    },
  });
  expect(result.calls).toBe(2);
  expect(result.error).toBe("call_budget_exhausted");
  expect(result.finalized).toBe(false);
});
test("deadline cancels provider stream and reports unknown usage", async () => {
  const result = await new ForgeRunner().run({
    ...base,
    deadlineMs: 20,
    tools: [],
    stream: (_m, _c, options) => {
      const s = createAssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () =>
          s.push({
            type: "error",
            reason: "aborted",
            error: {
              ...message([]),
              stopReason: "aborted",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            },
          }),
        { once: true },
      );
      return s;
    },
  });
  expect(result.error).toBe("deadline_or_cancelled");
  expect(result.usage).toBeNull();
  expect(result.elapsedMs).toBeLessThan(300);
});
