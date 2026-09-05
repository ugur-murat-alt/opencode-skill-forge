import { describe, expect, test } from "bun:test";
import type {
  CoreActivation,
  CoreRuntimeContext,
} from "./legacy-runtime/core-runtime.js";
import {
  setupSprHandoff,
  SPR_HANDOFF_SYSTEM,
  SPR_HANDOFF_TOOL,
} from "./legacy-runtime/spr-handoff.js";

function makeHarness() {
  let contextHook:
    | ((event: {
        sessionID: string;
        agent?: string | null;
        system: Array<{ type: string; text?: string }>;
        tools: Record<string, unknown>;
      }) => Promise<void> | void)
    | undefined;
  let registeredTool: Record<string, any> | undefined;
  const handoffs: unknown[] = [];
  const runtime = {
    session: {
      hook: async (_name: "context", callback: typeof contextHook) => {
        contextHook = callback;
      },
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        location: { directory: "/workspace", workspaceID: "ws-1" },
      }),
    },
    tool: {
      transform: async (
        callback: (draft: { add(tool: Record<string, unknown>): void }) => void,
      ) => {
        callback({
          add(tool) {
            registeredTool = tool;
          },
        });
      },
    },
  };
  const activation = {
    activationID: "test",
    compatible: true,
    createContext: () => ({}) as CoreRuntimeContext,
    enqueueHandoff: async (input: unknown) => {
      handoffs.push(input);
      return true;
    },
    cleanup() {},
    unregister() {},
  } satisfies CoreActivation<CoreRuntimeContext>;
  return {
    runtime,
    activation,
    handoffs,
    getContextHook: () => contextHook,
    getTool: () => registeredTool,
  };
}

describe("SPR handoff", () => {
  test("injects the final-step instruction only for configured agents", async () => {
    const harness = makeHarness();
    await setupSprHandoff(harness.runtime, harness.activation, ["build"]);
    const hook = harness.getContextHook()!;

    const allowed = {
      sessionID: "owner",
      agent: "build",
      system: [] as Array<{ type: string; text?: string }>,
      tools: { [SPR_HANDOFF_TOOL]: {} },
    };
    await hook(allowed);
    await hook(allowed);
    expect(allowed.system).toEqual([
      { type: "text", text: SPR_HANDOFF_SYSTEM },
    ]);

    const blocked = {
      sessionID: "other",
      agent: "explore",
      system: [] as Array<{ type: string; text?: string }>,
      tools: { [SPR_HANDOFF_TOOL]: {}, read: {} },
    };
    await hook(blocked);
    expect(blocked.system).toEqual([]);
    expect(blocked.tools).toEqual({ read: {} });
  });

  test("queues one bounded handoff without copying session history", async () => {
    const harness = makeHarness();
    await setupSprHandoff(harness.runtime, harness.activation, ["build"]);
    const execute = harness.getTool()!.execute as (
      args: Record<string, unknown>,
      context: { sessionID: string; agent: string; messageID: string },
    ) => Promise<unknown>;

    expect(
      await execute(
        { summary: "Verified reusable workflow and its constraints." },
        { sessionID: "owner", agent: "build", messageID: "assistant-1" },
      ),
    ).toEqual({ ok: true, queued: true });
    expect(harness.handoffs).toEqual([
      {
        agent: "build",
        directory: "/workspace",
        workspaceID: "ws-1",
        summary: "Verified reusable workflow and its constraints.",
      },
    ]);

    expect(
      await execute(
        { summary: "A duplicate should not launch another review." },
        { sessionID: "owner", agent: "build", messageID: "assistant-1" },
      ),
    ).toEqual({ ok: true, queued: false, reason: "already-queued" });
    expect(harness.handoffs).toHaveLength(1);

    expect(
      await execute(
        { summary: "A later verified workflow may be reviewed independently." },
        { sessionID: "owner", agent: "build", messageID: "assistant-2" },
      ),
    ).toEqual({ ok: true, queued: true });
    expect(harness.handoffs).toHaveLength(2);
  });

  test("atomically deduplicates concurrent calls from one model turn", async () => {
    const harness = makeHarness();
    await setupSprHandoff(harness.runtime, harness.activation, ["build"]);
    const execute = harness.getTool()!.execute as (
      args: Record<string, unknown>,
      context: { sessionID: string; agent: string; messageID: string },
    ) => Promise<unknown>;

    const results = await Promise.all([
      execute(
        { summary: "Concurrent reusable workflow." },
        { sessionID: "owner", agent: "build", messageID: "assistant-1" },
      ),
      execute(
        { summary: "Concurrent reusable workflow." },
        { sessionID: "owner", agent: "build", messageID: "assistant-1" },
      ),
    ]);
    expect(results).toContainEqual({ ok: true, queued: true });
    expect(results).toContainEqual({
      ok: true,
      queued: false,
      reason: "already-queued",
    });
    expect(harness.handoffs).toHaveLength(1);
  });

  test("fails closed for disallowed agents and missing locations", async () => {
    const harness = makeHarness();
    harness.runtime.session.get = async () => ({ id: "owner" });
    await setupSprHandoff(harness.runtime, harness.activation, ["build"]);
    const execute = harness.getTool()!.execute as (
      args: Record<string, unknown>,
      context: { sessionID: string; agent: string; messageID: string },
    ) => Promise<Record<string, unknown>>;

    expect(
      await execute(
        { summary: "Reusable" },
        { sessionID: "owner", agent: "general", messageID: "assistant-1" },
      ),
    ).toEqual({ ok: false, error: "SPR handoff is not allowed here" });
    expect(
      await execute(
        { summary: "Reusable" },
        { sessionID: "owner", agent: "build", messageID: "assistant-1" },
      ),
    ).toEqual({ ok: false, error: "session location is unavailable" });
    expect(harness.handoffs).toEqual([]);
  });

  test("disposes partial registrations when setup fails", async () => {
    const harness = makeHarness();
    const disposed: string[] = [];
    const registration = (name: string) => ({
      async dispose() {
        disposed.push(name);
      },
    });
    const runtime = {
      // command.transform is intentionally not used: registering a command
      // during plugin setup wedges the OpenCode 2 model catalog.
      tool: {
        transform: async () => registration("tool"),
      },
      session: {
        get: harness.runtime.session.get,
        hook: async () => {
          throw new Error("hook registration failed");
        },
      },
    };

    await expect(
      setupSprHandoff(runtime, harness.activation, ["build"]),
    ).rejects.toThrow("hook registration failed");
    expect(disposed).toEqual(["tool"]);
  });
});
