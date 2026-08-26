import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerContextHook,
  userText,
  type ContextHookDeps,
} from "../../src/prompt-editor/context-hook.js";
import { PROMPT_EDITOR_DEFAULTS } from "../../src/prompt-editor/config.js";
import {
  readStates,
  sessionFlagsFile,
  statesFile,
  type PromptEditorRequest,
} from "../../src/prompt-editor/live.js";
import { writeSessionFlags } from "./helpers.js";
import { EditorRegistry } from "../../src/prompt-editor/runner.js";
import { readJournal } from "../../src/prompt-editor/journal.js";
import type {
  ContextHookEvent,
  PluginRuntime,
  SubmitPayload,
} from "../../src/prompt-editor/types.js";

const sandboxes: string[] = [];
const previousHome = process.env.OC_SKILL_POWER_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.OC_SKILL_POWER_HOME;
  else process.env.OC_SKILL_POWER_HOME = previousHome;
  for (const sandbox of sandboxes.splice(0))
    rmSync(sandbox, { recursive: true, force: true });
});

function request(
  kind: PromptEditorRequest["kind"],
  gateID: string,
  revision: number,
): PromptEditorRequest {
  return {
    protocolVersion: 2,
    kind,
    sessionID: "ses_main",
    messageID: "msg_current",
    gateID,
    revision,
    ts: Date.now(),
  };
}

function event(): ContextHookEvent {
  return {
    sessionID: "ses_main",
    agent: "build",
    system: [],
    messages: [
      {
        id: "msg_first",
        role: "user",
        content: [{ type: "text", text: "Start the implementation" }],
      },
      {
        id: "msg_assistant",
        role: "assistant",
        content: [{ type: "text", text: "The baseline tests pass." }],
      },
      {
        id: "msg_tool",
        role: "tool",
        content: [
          {
            type: "tool-result",
            result: { type: "text", value: "110 tests passed" },
          },
        ],
      },
      {
        id: "msg_current",
        role: "user",
        content: [
          {
            type: "text",
            text: "Continue the existing work and fix the remaining issue.",
          },
        ],
      },
    ],
    tools: {},
  };
}

async function setup(
  responses: Array<SubmitPayload | null>,
  options: {
    autoAccept?: boolean;
    blocking?: boolean;
    directory?: string | null;
    breakStates?: boolean;
    persistDelay?: Promise<void>;
    directoryDelay?: Promise<void>;
    directoryStarted?: () => void;
    runEditor?: ContextHookDeps["runEditor"];
  } = {},
) {
  const sandbox = mkdtempSync(join(tmpdir(), "pe-manual-"));
  sandboxes.push(sandbox);
  process.env.OC_SKILL_POWER_HOME = sandbox;
  writeSessionFlags(sessionFlagsFile(), "ses_main", {
    autoAccept: options.autoAccept ?? false,
  });
  if (options.breakStates) mkdirSync(statesFile(), { recursive: true });
  let hook: ((event: ContextHookEvent) => Promise<void> | void) | undefined;
  const prompts: string[] = [];
  const persisted: Array<Record<string, unknown>> = [];
  const registry = new EditorRegistry();
  const ctx = {
    session: {
      hook: async (_name: "context", callback: typeof hook) => {
        hook = callback;
      },
      create: async () => ({ id: "editor" }),
      prompt: async () => undefined,
      wait: async () => undefined,
      interrupt: async () => undefined,
      get: async () => ({ location: { directory: "/workspace/current" } }),
    },
    agent: {
      transform: async () => undefined,
      list: async () => ({
        location: { directory: "/workspace/current" },
        data: [],
      }),
    },
    tool: { transform: async () => undefined },
    event: { subscribe: () => (async function* () {})() },
  } as unknown as PluginRuntime;
  const deps: ContextHookDeps = {
    cfg: {
      ...PROMPT_EDITOR_DEFAULTS,
      enabled: true,
      blocking: options.blocking ?? false,
      minChars: 1,
      persist: true,
    },
    registry,
    learnFile: join(sandbox, "learn.md"),
    journalFile: join(sandbox, "journal.jsonl"),
    rewriteFile: join(sandbox, "rewrites.jsonl"),
    sessionFlagsFile: sessionFlagsFile(),
    resolveDirectory: async () => {
      options.directoryStarted?.();
      await options.directoryDelay;
      return options.directory === undefined
        ? "/workspace/current"
        : options.directory;
    },
    isExcludedSession: () => false,
    log: () => undefined,
    runEditor:
      options.runEditor ??
      (async (_ctx, _deps, buildPrompt) => {
        prompts.push(buildPrompt());
        return responses.shift() ?? null;
      }),
    persistRewrite: async (input) => {
      persisted.push(input as unknown as Record<string, unknown>);
      await options.persistDelay;
      return "updated";
    },
  };
  const controller = await registerContextHook(ctx, deps);
  return {
    controller,
    hook: hook!,
    prompts,
    persisted,
    registry,
    journalFile: join(sandbox, "journal.jsonl"),
    learnFile: join(sandbox, "learn.md"),
  };
}

async function waitForPhase(phase: string, revision?: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const latest = readStates(statesFile())[0];
    if (
      latest?.phase === phase &&
      (revision === undefined || latest.revision === revision)
    )
      return latest;
    await Bun.sleep(1);
  }
  throw new Error(`prompt editor never reached ${phase}`);
}

describe("manual prompt approval", () => {
  test("accept holds provider dispatch and applies the selected candidate", async () => {
    const { controller, hook, prompts, persisted, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const input = event();
    const dispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);

    expect(
      await Promise.race([
        dispatch.then(() => "settled"),
        Bun.sleep(5).then(() => "pending"),
      ]),
    ).toBe("pending");
    expect(prompts[0]).toContain('"directory":"/workspace/current"');
    expect(prompts[0]).toContain("The baseline tests pass.");
    expect(prompts[0]).toContain("110 tests passed");

    expect(
      await controller.processRequest(request("accept", awaiting.gateID!, 1)),
    ).toBe(true);
    await dispatch;
    expect(userText(input.messages.at(-1)!)).toBe("Improved request");
    expect(persisted).toHaveLength(1);
    expect(readStates(statesFile())[0]).toMatchObject({
      phase: "accepted",
      revision: 1,
      autoAccept: false,
      applied: true,
    });
    await controller.stop();
    registry.dispose();
  });

  test("passes only the main agent's effective tools into the editor prompt", async () => {
    const { controller, hook, prompts, registry } = await setup([
      { prompt: "Improved request with tool guidance" },
    ]);
    const input = event();
    input.tools = {
      read: { description: "Read workspace files." },
      github_search_code: { description: "Search GitHub code." },
      omni_prompt_submit: { description: "Submit the editor result." },
    };
    const dispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);

    expect(prompts[0]).toContain("MAIN AGENT EXECUTION CAPABILITIES");
    expect(prompts[0]).toContain('`read` — "Read workspace files."');
    expect(prompts[0]).toContain(
      '`github_search_code` — "Search GitHub code."',
    );
    expect(prompts[0]).not.toContain("Submit the editor result.");

    expect(
      await controller.processRequest(request("reject", awaiting.gateID!, 1)),
    ).toBe(true);
    await dispatch;
    await controller.stop();
    registry.dispose();
  });

  test("reject releases only the original and never persists the candidate", async () => {
    const { controller, hook, persisted, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const input = event();
    const original = userText(input.messages.at(-1)!);
    const dispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);

    expect(
      await controller.processRequest(request("reject", awaiting.gateID!, 1)),
    ).toBe(true);
    await dispatch;
    expect(userText(input.messages.at(-1)!)).toBe(original);
    expect(persisted).toHaveLength(0);
    expect(readStates(statesFile())[0]?.phase).toBe("rejected");
    await controller.stop();
    registry.dispose();
  });

  test("accept fails closed if the source changes while approval waits", async () => {
    const { controller, hook, persisted, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const input = event();
    const dispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    input.messages.at(-1)!.content = [
      { type: "text", text: "Externally changed request" },
    ];
    expect(
      await controller.processRequest(request("accept", awaiting.gateID!, 1)),
    ).toBe(true);
    await expect(dispatch).rejects.toThrow("source changed");
    expect(userText(input.messages.at(-1)!)).toBe("Externally changed request");
    expect(persisted).toHaveLength(0);
    expect(readStates(statesFile())[0]?.phase).toBe("cancelled");
    await controller.stop();
    registry.dispose();
  });

  test("reject fails closed if the source changes while approval waits", async () => {
    const { controller, hook, persisted, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const input = event();
    const dispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    input.messages.at(-1)!.content = [
      { type: "text", text: "Externally changed request" },
    ];
    expect(
      await controller.processRequest(request("reject", awaiting.gateID!, 1)),
    ).toBe(true);
    await expect(dispatch).rejects.toThrow("source changed");
    expect(userText(input.messages.at(-1)!)).toBe("Externally changed request");
    expect(persisted).toHaveLength(0);
    expect(readStates(statesFile())[0]?.phase).toBe("cancelled");
    await controller.stop();
    registry.dispose();
  });

  test("concurrent hooks accept one shared candidate without false source drift", async () => {
    const { controller, hook, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const input = event();
    const firstDispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    const secondDispatch = Promise.resolve(hook(input));
    expect(
      await controller.processRequest(request("accept", awaiting.gateID!, 1)),
    ).toBe(true);
    await expect(
      Promise.all([firstDispatch, secondDispatch]),
    ).resolves.toBeDefined();
    expect(userText(input.messages.at(-1)!)).toBe("Improved request");
    expect(readStates(statesFile())[0]).toMatchObject({
      phase: "accepted",
      applied: true,
    });
    await controller.stop();
    registry.dispose();
  });

  test("a drifted duplicate cannot cancel an already-applied shared candidate", async () => {
    const { controller, hook, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const original = event();
    const drifted = event();
    drifted.messages.at(-1)!.content = [
      { type: "text", text: "Externally changed duplicate" },
    ];
    const originalDispatch = Promise.resolve(hook(original));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    const driftedDispatch = Promise.resolve(hook(drifted)).then(
      () => null,
      (error: unknown) => error,
    );
    await Bun.sleep(1);
    expect(
      await controller.processRequest(request("accept", awaiting.gateID!, 1)),
    ).toBe(true);
    await expect(originalDispatch).resolves.toBeUndefined();
    expect((await driftedDispatch) as Error).toHaveProperty(
      "message",
      expect.stringContaining("source changed"),
    );
    expect(userText(original.messages.at(-1)!)).toBe("Improved request");
    expect(userText(drifted.messages.at(-1)!)).toBe(
      "Externally changed duplicate",
    );
    expect(readStates(statesFile())[0]).toMatchObject({
      phase: "accepted",
      applied: true,
    });
    await controller.stop();
    registry.dispose();
  });

  test("auto-accept cannot bypass a cached manual decision for the same id", async () => {
    const { controller, hook, prompts, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const original = event();
    const dispatch = Promise.resolve(hook(original));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    expect(
      await controller.processRequest(request("accept", awaiting.gateID!, 1)),
    ).toBe(true);
    await dispatch;
    writeSessionFlags(sessionFlagsFile(), "ses_main", { autoAccept: true });

    const duplicate = event();
    duplicate.messages.at(-1)!.content = [
      { type: "text", text: "Drifted duplicate after mode switch" },
    ];
    await expect(Promise.resolve(hook(duplicate))).rejects.toThrow(
      "source changed after manual decision",
    );
    expect(prompts).toHaveLength(1);
    expect(readStates(statesFile())[0]).toMatchObject({
      phase: "accepted",
      applied: true,
    });
    await controller.stop();
    registry.dispose();
  });

  test("oversized targets skip editing entirely", async () => {
    const { controller, hook, prompts, registry } = await setup([
      { prompt: "never" },
    ]);
    const input = event();
    input.messages.at(-1)!.content = [
      { type: "text", text: "x".repeat(PROMPT_EDITOR_DEFAULTS.maxChars + 1) },
    ];
    await Promise.resolve(hook(input));
    expect(prompts).toHaveLength(0);
    expect(readStates(statesFile())).toHaveLength(0);
    await controller.stop();
    registry.dispose();
  });

  test("timeouts are recorded as errors with a reason, not silent passthrough", async () => {
    const { controller, hook, journalFile, registry } = await setup([], {
      autoAccept: true,
      blocking: true,
      runEditor: async (_ctx, runDeps) => {
        runDeps.onOutcome?.("timeout");
        return null;
      },
    });
    const input = event();
    await Promise.resolve(hook(input));
    const entry = readJournal(journalFile).at(-1);
    expect(entry?.outcome).toBe("error");
    expect(String(entry?.error)).toContain("timed out");
    expect(readStates(statesFile())[0]).toMatchObject({
      phase: "failed",
      error: expect.stringContaining("timed out"),
    });
    await controller.stop();
    registry.dispose();
  });

  test("re-evaluate invalidates the old revision and waits for the new decision", async () => {
    const { controller, hook, registry } = await setup([
      { prompt: "First candidate" },
      { prompt: "Second candidate" },
    ]);
    const input = event();
    const dispatch = Promise.resolve(hook(input));
    const first = await waitForPhase("awaiting-decision", 1);

    expect(
      await controller.processRequest(request("re-evaluate", first.gateID!, 1)),
    ).toBe(true);
    const second = await waitForPhase("awaiting-decision", 2);
    expect(
      await controller.processRequest(request("accept", first.gateID!, 1)),
    ).toBe(false);
    expect(
      await controller.processRequest(request("accept", second.gateID!, 2)),
    ).toBe(true);
    await dispatch;
    expect(userText(input.messages.at(-1)!)).toBe("Second candidate");
    await controller.stop();
    registry.dispose();
  });

  test("manual mode overrides non-blocking config and a failed editor needs reject", async () => {
    const { controller, hook, registry } = await setup([null], {
      blocking: false,
    });
    const input = event();
    const dispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    expect(
      await controller.processRequest(request("accept", awaiting.gateID!, 1)),
    ).toBe(false);
    expect(
      await controller.processRequest(request("reject", awaiting.gateID!, 1)),
    ).toBe(true);
    await dispatch;
    expect(userText(input.messages.at(-1)!)).toContain(
      "Continue the existing work",
    );
    await controller.stop();
    registry.dispose();
  });

  test("automatic mode keeps its fail-open behavior", async () => {
    const { controller, hook, registry } = await setup([null], {
      autoAccept: true,
      blocking: true,
    });
    const input = event();
    await hook(input);
    expect(userText(input.messages.at(-1)!)).toContain(
      "Continue the existing work",
    );
    expect(readStates(statesFile())[0]?.phase).toBe("failed");
    await controller.stop();
    registry.dispose();
  });

  test("default learn path stores an editor lesson", async () => {
    const { controller, hook, registry, learnFile } = await setup(
      [
        {
          prompt: "Improved prompt",
          learn: "Keep reusable constraints explicit.",
        },
      ],
      { autoAccept: true, blocking: true },
    );

    await hook(event());
    expect(readFileSync(learnFile, "utf8")).toContain(
      "Keep reusable constraints explicit.",
    );
    await controller.stop();
    registry.dispose();
  });

  test("a concurrent automatic hook stays fail-open when its inflight run rejects", async () => {
    let releaseDirectory!: () => void;
    let markDirectoryStarted!: () => void;
    const directoryDelay = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    const directoryStarted = new Promise<void>((resolve) => {
      markDirectoryStarted = resolve;
    });
    const { controller, hook, registry } = await setup([], {
      autoAccept: true,
      blocking: true,
      directory: null,
      directoryDelay,
      directoryStarted: markDirectoryStarted,
    });
    const first = event();
    const second = event();
    const firstDispatch = Promise.resolve(hook(first));
    await directoryStarted;
    const secondDispatch = Promise.resolve(hook(second));
    releaseDirectory();
    await expect(firstDispatch).resolves.toBeUndefined();
    await expect(secondDispatch).resolves.toBeUndefined();
    expect(userText(first.messages.at(-1)!)).toContain(
      "Continue the existing work",
    );
    expect(userText(second.messages.at(-1)!)).toContain(
      "Continue the existing work",
    );
    await controller.stop();
    registry.dispose();
  });

  test("session cancellation aborts an active editor run", async () => {
    let editorStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      editorStarted = resolve;
    });
    let aborted = false;
    const { controller, hook, registry } = await setup([], {
      autoAccept: true,
      blocking: true,
      runEditor: async (_ctx, runDeps) => {
        editorStarted();
        await new Promise<void>((resolve) => {
          runDeps.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              runDeps.onOutcome?.("cancelled");
              resolve();
            },
            { once: true },
          );
        });
        return null;
      },
    });
    const input = event();
    const running = Promise.resolve(hook(input));
    await started;
    controller.cancelSession("ses_main");
    await running;
    expect(aborted).toBe(true);
    expect(userText(input.messages.at(-1)!)).toContain(
      "Continue the existing work",
    );
    await controller.stop();
    registry.dispose();
  });

  test("a rewritten message with the same id is not edited again on a later hook", async () => {
    const { controller, hook, prompts, registry } = await setup([
      { prompt: "Improved request" },
      { prompt: "Should never run" },
    ]);
    const input = event();
    const firstDispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    await controller.processRequest(request("accept", awaiting.gateID!, 1));
    await firstDispatch;
    expect(userText(input.messages.at(-1)!)).toBe("Improved request");

    await hook(input);
    expect(prompts).toHaveLength(1);
    expect(userText(input.messages.at(-1)!)).toBe("Improved request");
    await controller.stop();
    registry.dispose();
  });

  test("non-blocking auto rewrites are recorded as not applied to dispatch", async () => {
    const { controller, hook, persisted, registry } = await setup(
      [{ prompt: "Background candidate" }],
      { autoAccept: true, blocking: false },
    );
    const input = event();
    await hook(input);
    expect(userText(input.messages.at(-1)!)).toContain(
      "Continue the existing work",
    );
    await waitForPhase("completed");
    expect(readStates(statesFile())[0]).toMatchObject({
      phase: "completed",
      applied: false,
    });
    expect(persisted).toHaveLength(0);
    await hook(input);
    expect(userText(input.messages.at(-1)!)).toContain(
      "Continue the existing work",
    );
    expect(persisted).toHaveLength(0);
    await controller.stop();
    registry.dispose();
  });

  test("a second manual message in the same session fails closed", async () => {
    const { controller, hook, registry } = await setup([
      { prompt: "First candidate" },
      { prompt: "Second candidate" },
    ]);
    const first = event();
    const firstDispatch = Promise.resolve(hook(first));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    const second = event();
    second.messages.at(-1)!.id = "msg_second";
    await expect(Promise.resolve(hook(second))).rejects.toThrow(
      "approval already pending",
    );
    await controller.processRequest(request("reject", awaiting.gateID!, 1));
    await firstDispatch;
    await controller.stop();
    registry.dispose();
  });

  test("shutdown cancels a manual gate instead of dispatching text", async () => {
    const { controller, hook, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const dispatch = Promise.resolve(hook(event()));
    await waitForPhase("awaiting-decision", 1);
    await controller.stop();
    await expect(dispatch).rejects.toThrow("approval cancelled");
    expect(readStates(statesFile())[0]?.phase).toBe("cancelled");
    registry.dispose();
  });

  test("interruption after accept but before apply never persists or dispatches the rewrite", async () => {
    const { controller, hook, persisted, registry } = await setup([
      { prompt: "Improved request" },
    ]);
    const input = event();
    const dispatch = Promise.resolve(hook(input));
    const awaiting = await waitForPhase("awaiting-decision", 1);
    expect(
      await controller.processRequest(request("accept", awaiting.gateID!, 1)),
    ).toBe(true);
    controller.cancelSession("ses_main");
    await expect(dispatch).rejects.toThrow("run cancelled");
    expect(persisted).toHaveLength(0);
    expect(userText(input.messages.at(-1)!)).toContain(
      "Continue the existing work",
    );
    expect(readStates(statesFile())[0]).toMatchObject({
      phase: "cancelled",
      applied: false,
    });
    await controller.stop();
    registry.dispose();
  });

  test("manual dispatch fails closed when its actionable state cannot be written", async () => {
    const { controller, hook, prompts, registry } = await setup(
      [{ prompt: "Must not run" }],
      { breakStates: true },
    );
    await expect(Promise.resolve(hook(event()))).rejects.toThrow(
      "manual state unavailable",
    );
    expect(prompts).toHaveLength(0);
    await controller.stop();
    registry.dispose();
  });

  test("an unavailable exact session directory never falls back to service cwd", async () => {
    const { controller, hook, prompts, registry } = await setup(
      [{ prompt: "Must not run" }],
      { directory: null },
    );
    await expect(Promise.resolve(hook(event()))).rejects.toThrow(
      "session directory unavailable",
    );
    expect(prompts).toHaveLength(0);
    await controller.stop();
    registry.dispose();
  });
});
