import { test, expect } from "bun:test";
import { measureCall } from "../scripts/benchmark-measure.mjs";

test("catalog measurement includes transport, tool and malformed response failures", async () => {
  const samples: any[] = [];
  for (const callTool of [
    async () => {
      throw Error("transport timeout");
    },
    async () => ({
      isError: true,
      content: [{ type: "text", text: "denied" }],
    }),
    async () => ({ content: [{ type: "text", text: "not JSON" }] }),
  ]) {
    await expect(
      measureCall(
        { callTool },
        "forge_load",
        {},
        "soak",
        (v: any) => samples.push(v),
        performance.now() - 50,
      ),
    ).rejects.toThrow();
  }
  expect(samples).toHaveLength(3);
  for (const sample of samples) {
    expect(sample.outcome).toBe("error");
    expect(sample.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(sample.scheduler_delay_ms).toBeGreaterThanOrEqual(50);
    expect(sample.scheduled_to_complete_ms).toBeGreaterThanOrEqual(
      sample.elapsed_ms,
    );
  }
  expect(samples[0].response_bytes).toBe(0);
  expect(samples[1].response_bytes).toBeGreaterThan(0);
});

test("catalog measurement preserves actual response and separates scheduling delay", async () => {
  const samples: any[] = [];
  const result = await measureCall(
    {
      callTool: async () => ({
        content: [{ type: "text", text: '{"items":[]}' }],
      }),
    },
    "forge_search",
    {},
    "warm",
    (v: any) => samples.push(v),
  );
  expect(result).toEqual({ items: [] });
  expect(samples).toHaveLength(1);
  expect(samples[0].outcome).toBe("success");
  expect(samples[0].scheduler_delay_ms).toBe(0);
  expect(samples[0].scheduled_to_complete_ms).toBe(samples[0].elapsed_ms);
});
