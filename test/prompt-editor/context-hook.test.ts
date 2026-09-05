import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastUserMessage,
  userText,
  applyRewrite,
  registerContextHook,
  type ContextHookDeps,
} from "../legacy-runtime/prompt-editor/context-hook.js";
import type {
  ChatMessage,
  ContextHookEvent,
  MessageContentPart,
  PluginRuntime,
} from "../legacy-runtime/prompt-editor/types.js";
import {
  agentPermissions,
  resolveAgentModel,
} from "../legacy-runtime/prompt-editor/agent.js";
import type { PromptEditorConfig } from "../legacy-runtime/prompt-editor/config.js";
import { PROMPT_EDITOR_DEFAULTS } from "../legacy-runtime/prompt-editor/config.js";
import { EditorRegistry } from "../legacy-runtime/prompt-editor/runner.js";

let sandbox: string;
let previousSkillPowerHome: string | undefined;
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "pe-context-hook-"));
  previousSkillPowerHome = process.env.OC_SKILL_POWER_HOME;
  process.env.OC_SKILL_POWER_HOME = sandbox;
});
afterAll(() => {
  if (previousSkillPowerHome === undefined)
    delete process.env.OC_SKILL_POWER_HOME;
  else process.env.OC_SKILL_POWER_HOME = previousSkillPowerHome;
  rmSync(sandbox, { recursive: true, force: true });
});

const cfg: PromptEditorConfig = {
  ...PROMPT_EDITOR_DEFAULTS,
  enabled: true,
  model: "acme/fast",
  variant: null,
  maxSteps: 10,
  timeoutMs: 30_000,
  blocking: false,
  minChars: 20,
};

describe("lastUserMessage", () => {
  test("returns the last user message", () => {
    const messages: ChatMessage[] = [
      { id: "a", role: "user", content: [{ type: "text", text: "hi" }] },
      { id: "b", role: "assistant", content: [{ type: "text", text: "ok" }] },
      { id: "c", role: "user", content: [{ type: "text", text: "now this" }] },
    ];
    expect(lastUserMessage(messages)?.id).toBe("c");
  });

  test("returns null when there is no user message", () => {
    expect(
      lastUserMessage([
        { id: "a", role: "assistant", content: [{ type: "text", text: "x" }] },
      ]),
    ).toBeNull();
  });

  test("ignores id-less synthetic user context appended after the real message", () => {
    const messages: ChatMessage[] = [
      { id: "real", role: "user", content: "real prompt" },
      { role: "user", content: "synthetic context" },
    ];
    expect(lastUserMessage(messages)?.id).toBe("real");
  });
});

describe("userText", () => {
  test("joins text parts, ignoring media", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "alpha " },
        { type: "media", data: "data:image/png;base64,xx" },
        { type: "text", text: "beta" },
      ],
    };
    expect(userText(msg)).toBe("alpha beta");
  });

  test("string content is returned as-is", () => {
    expect(
      userText({ role: "user", content: "plain" } as unknown as ChatMessage),
    ).toBe("plain");
  });

  test("null for empty text", () => {
    expect(
      userText({ role: "user", content: [] as MessageContentPart[] }),
    ).toBeNull();
  });
});

describe("applyRewrite", () => {
  test("replaces text parts and preserves media", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "old" },
        { type: "media", data: "data:xxx" },
        { type: "text", text: "more" },
      ],
    };
    applyRewrite(msg, "new prompt");
    const texts = msg
      .content!.filter((p) => p.type === "text")
      .map((p) => p.text);
    expect(texts).toEqual(["new prompt"]);
    expect(msg.content!.some((p) => p.type === "media")).toBe(true);
  });

  test("string content becomes a text part", () => {
    const msg = { role: "user", content: "old" } as unknown as ChatMessage;
    applyRewrite(msg, "new");
    expect(msg.content).toEqual([{ type: "text", text: "new" }]);
  });
});

describe("agent permissions", () => {
  test("deny-first with allowlist + submit tool always present", () => {
    const perms = agentPermissions(cfg);
    expect(perms[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    const actions = perms.map((p) => p.action);
    expect(actions).toEqual([
      "*",
      "read",
      "grep",
      "glob",
      "omni_prompt_submit",
    ]);
  });

  test("model resolution", () => {
    expect(resolveAgentModel(cfg, { model: null } as never)).toEqual({
      providerID: "acme",
      id: "fast",
    });
    expect(
      resolveAgentModel(cfg, { model: "acme/fast", variant: "low" } as never)
        ?.variant,
    ).toBe("low");
    expect(() =>
      resolveAgentModel({ ...cfg, model: "no-slash" }, {
        model: null,
      } as never),
    ).toThrow();
  });
});

test("omni-spr bypasses editing even when agent metadata fails", async () => {
  let captured: ((event: ContextHookEvent) => Promise<void> | void) | undefined;
  let agentListCalls = 0;
  let editorCreates = 0;
  const registry = new EditorRegistry();
  const ctx = {
    session: {
      hook: async (_name: "context", callback: typeof captured) => {
        captured = callback;
      },
      create: async () => {
        editorCreates += 1;
        return { id: "editor" };
      },
      prompt: async () => undefined,
      interrupt: async () => undefined,
      get: async () => undefined,
    },
    agent: {
      transform: async () => undefined,
      list: async () => {
        agentListCalls += 1;
        throw new Error("metadata unavailable");
      },
    },
    tool: { transform: async () => undefined },
    event: { subscribe: () => (async function* () {})() },
  } as unknown as PluginRuntime;
  const deps = {
    cfg,
    registry,
    learnFile: "",
    journalFile: "",
    rewriteFile: "",
    sessionFlagsFile: "",
    resolveDirectory: async () => null,
    isExcludedSession: () => false,
    log: () => undefined,
  } as ContextHookDeps;

  await registerContextHook(ctx, deps);
  await captured!({
    sessionID: "review",
    agent: "omni-spr",
    system: [],
    messages: [
      {
        id: "message",
        role: "user",
        content: [{ type: "text", text: "Review this completed workflow" }],
      },
    ],
    tools: {},
  });

  expect(agentListCalls).toBe(0);
  expect(editorCreates).toBe(0);
  registry.dispose();
});

test("agent metadata failure passes a primary-looking prompt through", async () => {
  let captured: ((event: ContextHookEvent) => Promise<void> | void) | undefined;
  let editorCreates = 0;
  const registry = new EditorRegistry();
  const ctx = {
    session: {
      hook: async (_name: "context", callback: typeof captured) => {
        captured = callback;
      },
      create: async () => {
        editorCreates += 1;
        return { id: "editor" };
      },
      prompt: async () => undefined,
      wait: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ location: { directory: "/tmp" } }),
    },
    agent: {
      transform: async () => undefined,
      list: async () => {
        throw new Error("metadata unavailable");
      },
    },
    tool: { transform: async () => undefined },
    event: { subscribe: () => (async function* () {})() },
  } as unknown as PluginRuntime;
  const deps = {
    cfg,
    registry,
    learnFile: "",
    journalFile: "",
    rewriteFile: "",
    sessionFlagsFile: "",
    resolveDirectory: async () => "/tmp",
    isExcludedSession: () => false,
    log: () => undefined,
  } as ContextHookDeps;

  const controller = await registerContextHook(ctx, deps);
  await captured!({
    sessionID: "possibly-derived",
    agent: "general",
    system: [],
    messages: [
      {
        id: "message",
        role: "user",
        content: [
          {
            type: "text",
            text: "Please improve this sufficiently long prompt",
          },
        ],
      },
    ],
    tools: {},
  });

  expect(editorCreates).toBe(0);
  await controller.stop();
  registry.dispose();
});

test("multiple activations process one session message only once", async () => {
  const callbacks: Array<(event: ContextHookEvent) => Promise<void> | void> =
    [];
  let editorRuns = 0;
  const controllers: Array<Awaited<ReturnType<typeof registerContextHook>>> =
    [];
  const registries: EditorRegistry[] = [];

  for (let index = 0; index < 2; index += 1) {
    const registry = new EditorRegistry();
    registries.push(registry);
    const ctx = {
      session: {
        hook: async (
          _name: "context",
          callback: (event: ContextHookEvent) => Promise<void> | void,
        ) => {
          callbacks.push(callback);
        },
        create: async () => ({ id: `editor-${index}` }),
        prompt: async () => undefined,
        wait: async () => undefined,
        interrupt: async () => undefined,
        get: async () => ({ location: { directory: "/tmp" } }),
      },
      agent: {
        transform: async () => undefined,
        list: async () => ({
          location: { directory: "/tmp" },
          data: [{ id: "build", mode: "primary", hidden: false }],
        }),
      },
      tool: { transform: async () => undefined },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as PluginRuntime;
    controllers.push(
      await registerContextHook(ctx, {
        cfg: { ...cfg, blocking: true, persist: false },
        registry,
        learnFile: "",
        journalFile: "",
        rewriteFile: "",
        sessionFlagsFile: `/tmp/prompt-editor-claims-${Date.now()}-${index}`,
        resolveDirectory: async () => "/tmp",
        isExcludedSession: () => false,
        log: () => undefined,
        runEditor: async () => {
          editorRuns += 1;
          return { prompt: "Improved shared prompt" };
        },
      }),
    );
  }

  await Promise.all(
    callbacks.map((callback) =>
      callback({
        sessionID: "shared-owner",
        agent: "build",
        system: [],
        messages: [
          {
            id: "shared-message",
            role: "user",
            content: [
              { type: "text", text: "Please improve this shared prompt once" },
            ],
          },
        ],
        tools: {},
      }),
    ),
  );

  expect(editorRuns).toBe(1);
  await Promise.all(controllers.map((controller) => controller.stop()));
  for (const registry of registries) registry.dispose();
});

test("non-user durable messages are never sent to the editor", async () => {
  let captured: ((event: ContextHookEvent) => Promise<void> | void) | undefined;
  let editorRuns = 0;
  const registry = new EditorRegistry();
  const ctx = {
    session: {
      hook: async (
        _name: "context",
        callback: (event: ContextHookEvent) => Promise<void> | void,
      ) => {
        captured = callback;
      },
      create: async () => ({ id: "editor" }),
      prompt: async () => undefined,
      wait: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ location: { directory: "/tmp" } }),
    },
    agent: {
      transform: async () => undefined,
      list: async () => ({
        location: { directory: "/tmp" },
        data: [{ id: "build", mode: "primary", hidden: false }],
      }),
    },
    tool: { transform: async () => undefined },
    event: { subscribe: () => (async function* () {})() },
  } as unknown as PluginRuntime;
  const controller = await registerContextHook(ctx, {
    cfg: { ...cfg, blocking: true, persist: false },
    registry,
    learnFile: "",
    journalFile: "",
    rewriteFile: "",
    sessionFlagsFile: `/tmp/prompt-editor-origin-${Date.now()}`,
    resolveDirectory: async () => "/tmp",
    resolveMessageType: async (_sessionID, messageID) => {
      if (messageID === "resolver-error") throw new Error("lookup failed");
      return (
        {
          synthetic: "synthetic",
          shell: "shell",
          compaction: "compaction",
          missing: null,
        } as Record<string, string | null>
      )[messageID];
    },
    isExcludedSession: () => false,
    log: () => undefined,
    runEditor: async () => {
      editorRuns += 1;
      return { prompt: "should not run" };
    },
  });

  for (const messageID of [
    "synthetic",
    "shell",
    "compaction",
    "missing",
    "resolver-error",
  ]) {
    const message: ChatMessage = {
      id: messageID,
      role: "user",
      content: "Instructions injected by OpenCode",
    };
    await captured!({
      sessionID: "owner",
      agent: "build",
      system: [],
      messages: [message],
      tools: {},
    });
    expect(userText(message)).toBe("Instructions injected by OpenCode");
  }

  expect(editorRuns).toBe(0);
  await controller.stop();
  registry.dispose();
});

test("multiple locations use only the matching activation", async () => {
  const callbacks: Array<(event: ContextHookEvent) => Promise<void> | void> =
    [];
  const editorRuns: string[] = [];
  const controllers: Array<Awaited<ReturnType<typeof registerContextHook>>> =
    [];
  const registries: EditorRegistry[] = [];

  const activations = [
    { label: "other-directory", directory: "/workspace/a" },
    {
      label: "other-workspace",
      directory: "/workspace/b",
      workspaceID: "workspace-a",
    },
    {
      label: "matching-workspace",
      directory: "/workspace/b",
      workspaceID: "workspace-b",
    },
  ];
  for (const activation of activations) {
    const registry = new EditorRegistry();
    registries.push(registry);
    const ctx = {
      session: {
        hook: async (
          _name: "context",
          callback: (event: ContextHookEvent) => Promise<void> | void,
        ) => {
          callbacks.push(callback);
        },
        create: async () => ({ id: `editor-${activation.label}` }),
        prompt: async () => undefined,
        wait: async () => undefined,
        interrupt: async () => undefined,
        get: async () => ({
          location: {
            directory: "/workspace/b",
            workspaceID: "workspace-b",
          },
        }),
      },
      agent: {
        transform: async () => undefined,
        list: async () => ({
          location: {
            directory: activation.directory,
            ...(activation.workspaceID
              ? { workspaceID: activation.workspaceID }
              : {}),
          },
          data: [{ id: "build", mode: "primary", hidden: false }],
        }),
      },
      tool: { transform: async () => undefined },
      event: { subscribe: () => (async function* () {})() },
    } as unknown as PluginRuntime;
    controllers.push(
      await registerContextHook(ctx, {
        cfg: { ...cfg, blocking: true, persist: false },
        registry,
        learnFile: "",
        journalFile: "",
        rewriteFile: "",
        sessionFlagsFile: `/tmp/prompt-editor-location-${Date.now()}-${activation.label}`,
        resolveDirectory: async () => activation.directory,
        isExcludedSession: () => false,
        log: () => undefined,
        runEditor: async () => {
          editorRuns.push(activation.label);
          return { prompt: "Improved location-specific prompt" };
        },
      }),
    );
  }

  await Promise.all(
    callbacks.map((callback) =>
      callback({
        sessionID: "location-owner",
        agent: "build",
        system: [],
        messages: [
          {
            id: "location-message",
            role: "user",
            content: [
              { type: "text", text: "Please improve this prompt in project B" },
            ],
          },
        ],
        tools: {},
      }),
    ),
  );

  expect(editorRuns).toEqual(["matching-workspace"]);
  await Promise.all(controllers.map((controller) => controller.stop()));
  for (const registry of registries) registry.dispose();
});

test("an unavailable session inspection is bounded and passes the prompt through", async () => {
  let captured: ((event: ContextHookEvent) => Promise<void> | void) | undefined;
  let editorCreates = 0;
  const registry = new EditorRegistry();
  const ctx = {
    session: {
      hook: async (_name: "context", callback: typeof captured) => {
        captured = callback;
      },
      create: async () => {
        editorCreates += 1;
        return { id: "editor" };
      },
      prompt: async () => undefined,
      wait: async () => undefined,
      interrupt: async () => undefined,
      get: () => new Promise<never>(() => {}),
    },
    agent: {
      transform: async () => undefined,
      list: async () => ({ data: [] }),
    },
    tool: { transform: async () => undefined },
    event: { subscribe: () => (async function* () {})() },
  } as unknown as PluginRuntime;
  const deps = {
    cfg: { ...cfg, directoryTimeoutMs: 5 },
    registry,
    learnFile: "",
    journalFile: "",
    rewriteFile: "",
    sessionFlagsFile: "",
    resolveDirectory: async () => "/repo",
    isExcludedSession: () => false,
    log: () => undefined,
  } as ContextHookDeps;

  const controller = await registerContextHook(ctx, deps);
  await captured!({
    sessionID: "main",
    agent: "build",
    system: [],
    messages: [
      {
        id: "message",
        role: "user",
        content: "This real user prompt must pass through unchanged",
      },
    ],
    tools: {},
  });
  expect(editorCreates).toBe(0);
  await controller.stop();
  registry.dispose();
});
