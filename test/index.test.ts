import { expect, test } from "bun:test";
import { setup } from "../src/legacy-plugin.js";
import type { PluginRuntime } from "../src/prompt-editor/types.js";

test("variant-only SPR override is disposed with the wrapper", async () => {
  let disposed = 0;
  const sprAgent: Record<string, any> = {
    model: { providerID: "provider", id: "reviewer" },
  };
  const ctx = {
    options: {
      enabled: false,
      spr: { variant: "low" },
      promptEditor: { enabled: false },
    },
    session: {
      create: async () => ({ id: "unused" }),
      hook: async () => undefined,
      prompt: async () => undefined,
      wait: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ location: { directory: "/workspace" } }),
    },
    agent: {
      transform: async (
        callback: (draft: {
          update(
            id: string,
            update: (agent: Record<string, any>) => void,
          ): void;
        }) => void,
      ) => {
        callback({
          update(id, update) {
            if (id === "spr") update(sprAgent);
          },
        });
        return {
          async dispose() {
            disposed += 1;
          },
        };
      },
      list: async () => ({ data: [] }),
    },
    tool: { transform: async () => undefined },
    event: { subscribe: () => (async function* () {})() },
  } as unknown as PluginRuntime;

  const cleanup = await setup(ctx);
  expect(sprAgent.model).toEqual({
    providerID: "provider",
    id: "reviewer",
    variant: "low",
  });
  await cleanup();
  expect(disposed).toBe(1);
});
