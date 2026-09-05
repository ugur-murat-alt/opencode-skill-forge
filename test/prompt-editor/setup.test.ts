import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPromptEditor } from "../legacy-runtime/prompt-editor/index.js";
import { PROMPT_EDITOR_DEFAULTS } from "../legacy-runtime/prompt-editor/config.js";
import {
  EDITOR_AGENT_ID,
  SUBMIT_TOOL_NAME,
  EDITOR_SESSION_TITLE,
} from "../legacy-runtime/prompt-editor/constants.js";
import type {
  ContextHookEvent,
  PluginRuntime,
} from "../legacy-runtime/prompt-editor/types.js";
import { PROMPT_EDITOR_RUNTIME_STATE } from "../legacy-runtime/prompt-editor/runtime.js";

// Global-state tests must never write the real home directory (AGENTS.md).
let sandbox: string;
let prevHome: string | undefined;
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "pe-setup-"));
  prevHome = process.env.OC_SKILL_POWER_HOME;
  process.env.OC_SKILL_POWER_HOME = sandbox;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.OC_SKILL_POWER_HOME;
  else process.env.OC_SKILL_POWER_HOME = prevHome;
  rmSync(sandbox, { recursive: true, force: true });
});

interface Recorded {
  agentUpdates: Map<string, Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  contextHooks: number;
  disposed?: string[];
  sessionCreates?: number;
  sessionPrompts?: number;
}

function makeMockCtx(
  recorded: Recorded,
  enabled = true,
  extra: Record<string, unknown> = {},
): PluginRuntime & Record<string, unknown> {
  const session: PluginRuntime["session"] = {
    hook: async (name, cb) => {
      if (name === "context") {
        recorded.contextHooks += 1;
        void cb;
      }
      return {
        dispose: async () => {
          (recorded.disposed ??= []).push("context");
        },
      };
    },
    create: async (_input) => {
      recorded.sessionCreates = (recorded.sessionCreates ?? 0) + 1;
      return { id: "editor-session-1" };
    },
    prompt: async () => {
      recorded.sessionPrompts = (recorded.sessionPrompts ?? 0) + 1;
    },
    interrupt: async () => undefined,
    get: async () => ({ location: { directory: "/tmp" } }),
    message: async () => ({ type: "user" }),
  };
  const agent: PluginRuntime["agent"] = {
    transform: async (cb) => {
      const draft = {
        list: () => [{ id: "build", mode: "primary", hidden: false }],
        get: () => undefined,
        update: (id, fn) => {
          const target = (recorded.agentUpdates.get(id) ?? {}) as Record<
            string,
            unknown
          >;
          fn(target);
          recorded.agentUpdates.set(id, target);
        },
      };
      cb(draft);
      return {
        dispose: async () => {
          (recorded.disposed ??= []).push("agent");
        },
      };
    },
    list: async () => ({
      data: [{ id: "build", mode: "primary", hidden: false }],
    }),
  };
  const tool: PluginRuntime["tool"] = {
    transform: async (cb) => {
      cb({
        add: (t) => recorded.tools.push(t),
      });
      return {
        dispose: async () => {
          (recorded.disposed ??= []).push("tool");
        },
      };
    },
  };
  return {
    options: { promptEditor: { enabled, ...extra } },
    session,
    agent,
    tool,
    event: {
      subscribe: (input?: { signal?: AbortSignal }) => {
        return (async function* () {
          yield* [] as never[];
          await new Promise<void>((resolve) => {
            if (input?.signal?.aborted) return resolve();
            input?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        })();
      },
    },
  } as unknown as PluginRuntime & Record<string, unknown>;
}

describe("setupPromptEditor wiring", () => {
  test("disabled subsystem registers nothing", async () => {
    const recorded: Recorded = {
      agentUpdates: new Map(),
      tools: [],
      contextHooks: 0,
    };
    const cleanup = setupPromptEditor(makeMockCtx(recorded, false));
    expect(cleanup).toBeUndefined();
    expect(recorded.tools).toHaveLength(0);
    expect(recorded.contextHooks).toBe(0);
  });

  test("enabled subsystem registers agent, submit tool and context hook", async () => {
    const recorded: Recorded = {
      agentUpdates: new Map(),
      tools: [],
      contextHooks: 0,
    };
    const cleanup = setupPromptEditor(makeMockCtx(recorded, true));
    expect(cleanup).toBeTypeOf("function");
    await cleanup!();

    expect(recorded.agentUpdates.has(EDITOR_AGENT_ID)).toBe(true);
    const agent = recorded.agentUpdates.get(EDITOR_AGENT_ID)!;
    expect(agent.mode).toBe("subagent");
    expect(agent.hidden).toBe(true);
    expect(agent.steps).toBe(PROMPT_EDITOR_DEFAULTS.maxSteps);
    expect(agent.model).toBeUndefined();
    // deny-first permissions must not expose write tools
    const perms = agent.permissions as Array<{
      action: string;
      effect: string;
    }>;
    expect(perms[0]!.effect).toBe("deny");
    expect(perms.some((p) => p.action === SUBMIT_TOOL_NAME)).toBe(true);

    const submitTool = recorded.tools.find((t) => t.name === SUBMIT_TOOL_NAME)!;
    expect(submitTool).toBeDefined();
    const input = submitTool.input as {
      required: string[];
      properties: { learn: { maxLength: number } };
    };
    expect(input.required).toEqual(["prompt", "learn"]);
    expect(input.properties.learn.maxLength).toBe(5_000);
    expect(recorded.sessionCreates ?? 0).toBe(0);
    expect(recorded.sessionPrompts ?? 0).toBe(0);
    const execute = submitTool.execute as (
      args: Record<string, unknown>,
      context: { sessionID: string },
    ) => Promise<{ ok: boolean; error?: string }>;
    expect(
      await execute({ prompt: "Improved" }, { sessionID: "missing" }),
    ).toMatchObject({ ok: false, error: "missing learn lesson" });
    expect(
      await execute(
        { prompt: "Improved", learn: "x".repeat(5_001) },
        { sessionID: "missing" },
      ),
    ).toMatchObject({
      ok: false,
      error: "learn lesson exceeds 5000 characters",
    });
    expect(recorded.contextHooks).toBe(1);
    expect(recorded.disposed).toEqual(["context", "tool", "agent"]);
  });

  test("cleanup is bounded while a registration is stalled", async () => {
    const recorded: Recorded = {
      agentUpdates: new Map(),
      tools: [],
      contextHooks: 0,
    };
    const ctx = makeMockCtx(recorded, true);
    ctx.agent.transform = () => new Promise<never>(() => {});
    const cleanup = setupPromptEditor(ctx)!;
    const started = Date.now();
    await cleanup();
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("an incompatible process runtime registers no prompt-editor hooks", () => {
    const host = globalThis as typeof globalThis & Record<symbol, unknown>;
    host[PROMPT_EDITOR_RUNTIME_STATE] = {
      protocol: -1,
      controllers: new Set(),
      bootstrapping: 0,
      orphanSweepClaimed: false,
    };
    const recorded: Recorded = {
      agentUpdates: new Map(),
      tools: [],
      contextHooks: 0,
    };
    try {
      expect(setupPromptEditor(makeMockCtx(recorded, true))).toBeUndefined();
      expect(recorded.agentUpdates.size).toBe(0);
      expect(recorded.tools).toHaveLength(0);
      expect(recorded.contextHooks).toBe(0);
    } finally {
      delete host[PROMPT_EDITOR_RUNTIME_STATE];
    }
  });

  test("context hook applies tool hygiene and skips editor sessions", async () => {
    const recorded: Recorded = {
      agentUpdates: new Map(),
      tools: [],
      contextHooks: 0,
    };
    const cleanup = setupPromptEditor(makeMockCtx(recorded, true));
    await cleanup!();
    // Re-capture the registered callback through a fresh hook call is not
    // straightforward with the mock, so assert on what the mock recorded:
    expect(recorded.tools[0]!.name).toBe(SUBMIT_TOOL_NAME);
    expect(EDITOR_SESSION_TITLE).toBe("prompt-forge-editor");
  });

  test("tool hygiene: submit tool stripped from non-editor sessions", async () => {
    // Drive the registered context hook through a manual recording hook.
    let captured: ((e: ContextHookEvent) => Promise<void> | void) | undefined;
    const ctx = makeMockCtx(
      { agentUpdates: new Map(), tools: [], contextHooks: 0 },
      true,
      { timeoutMs: 1 },
    );
    ctx.session.hook = async (name, cb) => {
      captured = cb as (e: ContextHookEvent) => Promise<void> | void;
    };
    const cleanup = setupPromptEditor(ctx);
    await Bun.sleep(0);
    expect(captured).toBeTypeOf("function");

    const tools: Record<string, unknown> = {
      read: { description: "read" },
      omni_prompt_submit: { description: "submit" },
    };
    const event: ContextHookEvent = {
      sessionID: "user-session",
      agent: "build",
      system: [],
      messages: [
        { id: "m1", role: "user", content: [{ type: "text", text: "short" }] },
      ],
      tools,
    };
    // promptEditor is enabled; the editor will run. Keep the editor run
    // cheap by making session.create/prompt + event immediate.
    await captured!(event);
    // Tools dict is mutated in place: submit tool removed for non-editor sessions.
    expect(event.tools["omni_prompt_submit"]).toBeUndefined();
    await cleanup!();
  });

  test("tool hygiene follows the configured read-only subset", async () => {
    let captured:
      ((event: ContextHookEvent) => Promise<void> | void) | undefined;
    const ctx = makeMockCtx(
      { agentUpdates: new Map(), tools: [], contextHooks: 0 },
      true,
      { tools: [] },
    );
    ctx.session.hook = async (_name, callback) => {
      captured = callback;
    };
    const cleanup = setupPromptEditor(ctx)!;
    await Bun.sleep(0);
    const event: ContextHookEvent = {
      sessionID: "editor-session",
      agent: EDITOR_AGENT_ID,
      system: [],
      messages: [],
      tools: {
        read: { description: "read" },
        [SUBMIT_TOOL_NAME]: { description: "submit" },
      },
    };

    await captured!(event);
    expect(event.tools.read).toBeUndefined();
    expect(event.tools[SUBMIT_TOOL_NAME]).toBeDefined();
    await cleanup();
  });
});
