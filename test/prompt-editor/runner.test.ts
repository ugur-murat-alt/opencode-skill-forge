import { describe, expect, test } from "bun:test";
import {
  EditorRegistry,
  runEditor,
  startEventLoop,
} from "../legacy-runtime/prompt-editor/runner.js";
import type { PluginRuntime } from "../legacy-runtime/prompt-editor/types.js";
import { storedMessageType } from "../legacy-runtime/prompt-editor/editor-session.js";
import {
  appendJournal,
  readJournal,
} from "../legacy-runtime/prompt-editor/journal.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("storedMessageType", () => {
  test("accepts direct and API-wrapped message records", () => {
    expect(storedMessageType({ type: "user" })).toBe("user");
    expect(storedMessageType({ data: { type: "synthetic" } })).toBe(
      "synthetic",
    );
    expect(storedMessageType({ data: {} })).toBeNull();
  });
});

describe("EditorRegistry", () => {
  test("submit resolves the outcome with the payload", async () => {
    const registry = new EditorRegistry();
    registry.attach("s1");
    const outcome = registry.waitOutcome("s1");
    expect(registry.submit("s1", { prompt: "better", learn: "lesson" })).toBe(
      true,
    );
    expect(await outcome).toEqual({ prompt: "better", learn: "lesson" });
  });

  test("session end without submit resolves null (fail-open)", async () => {
    const registry = new EditorRegistry();
    registry.attach("s2");
    const outcome = registry.waitOutcome("s2");
    registry.terminate("s2");
    expect(await outcome).toBeNull();
  });

  test("a second settle after submit is a no-op", async () => {
    const registry = new EditorRegistry();
    registry.attach("s3");
    const outcome = registry.waitOutcome("s3");
    registry.submit("s3", { prompt: "done" });
    registry.terminate("s3");
    expect(await outcome).toEqual({ prompt: "done" });
  });

  test("unknown session submit is rejected", () => {
    const registry = new EditorRegistry();
    expect(registry.submit("nope", { prompt: "x" })).toBe(false);
  });

  test("always-rewrite runs reject an unchanged submission without settling", async () => {
    const registry = new EditorRegistry();
    registry.attach("rewrite", {
      source: "Fix this prompt",
      requireRewrite: true,
    });
    const outcome = registry.waitOutcome("rewrite");

    expect(registry.submit("rewrite", { prompt: "  Fix this prompt  " })).toBe(
      false,
    );
    expect(
      registry.submit("rewrite", {
        prompt: "Correct and clarify this prompt.",
      }),
    ).toBe(true);
    expect(await outcome).toEqual({
      prompt: "Correct and clarify this prompt.",
    });
  });

  test("deletes the transient session after the editor settles", async () => {
    const registry = new EditorRegistry();
    const deleted: string[] = [];
    const ctx = {
      session: {
        create: async () => ({ id: "editor-session" }),
        prompt: async () => {
          registry.submit("editor-session", { prompt: "rewritten" });
        },
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;

    const result = await runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 100,
        deleteSession: async (sessionID) => {
          deleted.push(sessionID);
        },
      },
      () => "rewrite this",
    );

    expect(result).toEqual({ prompt: "rewritten" });
    expect(deleted).toEqual(["editor-session"]);
  });

  test("deletes the transient session when prompting fails", async () => {
    const registry = new EditorRegistry();
    const deleted: string[] = [];
    const ctx = {
      session: {
        create: async () => ({ id: "failed-editor-session" }),
        prompt: async () => {
          throw new Error("prompt failed");
        },
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;

    const result = await runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 100,
        deleteSession: async (sessionID) => {
          deleted.push(sessionID);
        },
      },
      () => "rewrite this",
    );

    expect(result).toBeNull();
    expect(deleted).toEqual(["failed-editor-session"]);
  });

  test("shutdown settles an active run and waits for session deletion", async () => {
    const registry = new EditorRegistry();
    const deleted: string[] = [];
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const ctx = {
      session: {
        create: async () => ({ id: "shutdown-editor-session" }),
        prompt: () => {
          promptStarted();
          return new Promise<never>(() => {});
        },
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;

    const running = runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 30_000,
        deleteSession: async (sessionID) => {
          deleted.push(sessionID);
        },
      },
      () => "rewrite this",
    );
    await started;

    registry.beginShutdown();
    expect(await running).toBeNull();
    await registry.waitForIdle();
    expect(deleted).toEqual(["shutdown-editor-session"]);
    expect(registry.activeCount()).toBe(0);
  });

  test("zero timeout fails open instead of leaving a run active", async () => {
    const registry = new EditorRegistry();
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const ctx = {
      session: {
        create: async () => ({ id: "zero-timeout-editor-session" }),
        prompt: () => {
          promptStarted();
          return new Promise<never>(() => {});
        },
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;
    const outcomes: string[] = [];
    const running = runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 0,
        deleteSession: async () => undefined,
        onOutcome: (outcome) => outcomes.push(outcome),
      },
      () => "rewrite this",
    );

    await started;
    expect(await running).toBeNull();
    expect(outcomes).toEqual(["timeout"]);
    expect(registry.activeCount()).toBe(0);
  });

  for (const stalledPhase of ["create", "prompt", "wait"] as const) {
    test(`an abort signal cancels a run stalled in ${stalledPhase}`, async () => {
      const registry = new EditorRegistry();
      const controller = new AbortController();
      let reachedPhase!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedPhase = resolve;
      });
      const never = () => new Promise<never>(() => {});
      const ctx = {
        session: {
          create:
            stalledPhase === "create"
              ? () => {
                  reachedPhase();
                  return never();
                }
              : async () => ({ id: `cancel-${stalledPhase}` }),
          prompt:
            stalledPhase === "prompt"
              ? () => {
                  reachedPhase();
                  return never();
                }
              : async () => undefined,
          wait:
            stalledPhase === "wait"
              ? () => {
                  reachedPhase();
                  return never();
                }
              : async () => undefined,
          interrupt: async () => undefined,
        },
      } as unknown as PluginRuntime;
      const outcomes: string[] = [];
      const running = runEditor(
        ctx,
        {
          registry,
          directory: "/tmp",
          timeoutMs: 30_000,
          signal: controller.signal,
          deleteSession: async () => undefined,
          onOutcome: (outcome) => outcomes.push(outcome),
        },
        () => "rewrite this",
      );

      await reached;
      controller.abort();
      expect(await running).toBeNull();
      expect(outcomes).toEqual(["cancelled"]);
      expect(registry.activeCount()).toBe(0);
    });
  }

  test("reports why a run produced no payload", async () => {
    // Clean idle without a submit -> "empty".
    const idleRegistry = new EditorRegistry();
    const reasons: string[] = [];
    const idleCtx = {
      session: {
        create: async () => ({ id: "idle-editor-session" }),
        prompt: async () => undefined,
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;
    expect(
      await runEditor(
        idleCtx,
        {
          registry: idleRegistry,
          directory: "/tmp",
          timeoutMs: 5_000,
          deleteSession: async () => undefined,
          onOutcome: (reason) => reasons.push(reason),
        },
        () => "rewrite this",
      ),
    ).toBeNull();
    expect(reasons).toEqual(["empty"]);

    // Deadline expiry while the prompt dispatch stalls -> "timeout".
    const stalledRegistry = new EditorRegistry();
    const timeoutReasons: string[] = [];
    const stalledCtx = {
      session: {
        create: async () => ({ id: "stalled-outcome-session" }),
        prompt: () => new Promise<never>(() => {}),
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;
    expect(
      await runEditor(
        stalledCtx,
        {
          registry: stalledRegistry,
          directory: "/tmp",
          timeoutMs: 1,
          deleteSession: async () => undefined,
          onOutcome: (reason) => timeoutReasons.push(reason),
        },
        () => "rewrite this",
      ),
    ).toBeNull();
    expect(timeoutReasons).toEqual(["timeout"]);
  });

  test("hard timeout also bounds a stalled prompt dispatch", async () => {
    const registry = new EditorRegistry();
    const deleted: string[] = [];
    const ctx = {
      session: {
        create: async () => ({ id: "stalled-editor-session" }),
        prompt: () => new Promise<never>(() => {}),
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;

    const result = await runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 1,
        deleteSession: async (sessionID) => {
          deleted.push(sessionID);
        },
      },
      () => "rewrite this",
    );

    expect(result).toBeNull();
    expect(deleted).toEqual(["stalled-editor-session"]);
    expect(registry.activeCount()).toBe(0);
  });

  test("hard timeout also bounds a stalled session wait", async () => {
    const registry = new EditorRegistry();
    const deleted: string[] = [];
    const ctx = {
      session: {
        create: async () => ({ id: "stalled-wait-session" }),
        prompt: async () => {
          registry.submit("stalled-wait-session", { prompt: "rewritten" });
        },
        wait: () => new Promise<never>(() => {}),
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;

    expect(
      await runEditor(
        ctx,
        {
          registry,
          directory: "/tmp",
          timeoutMs: 1,
          deleteSession: async (sessionID) => {
            deleted.push(sessionID);
          },
        },
        () => "rewrite this",
      ),
    ).toBeNull();
    expect(deleted).toEqual(["stalled-wait-session"]);
    expect(registry.activeCount()).toBe(0);
  });

  test("cleanup timeout bounds a stalled session deletion", async () => {
    const registry = new EditorRegistry();
    let deleteStarted = false;
    const ctx = {
      session: {
        create: async () => ({ id: "stalled-delete-session" }),
        prompt: async () => undefined,
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;

    expect(
      await runEditor(
        ctx,
        {
          registry,
          directory: "/tmp",
          timeoutMs: 1_000,
          cleanupTimeoutMs: 1,
          deleteSession: () => {
            deleteStarted = true;
            return new Promise<never>(() => {});
          },
        },
        () => "rewrite this",
      ),
    ).toBeNull();
    expect(deleteStarted).toBe(true);
    expect(registry.activeCount()).toBe(0);
  });

  test("hard timeout starts before session creation", async () => {
    const registry = new EditorRegistry();
    const ctx = {
      session: {
        create: () => new Promise(() => {}),
        prompt: async () => undefined,
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;
    const result = await runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 1,
        deleteSession: async () => undefined,
      },
      () => "prompt",
    );
    expect(result).toBeNull();
    expect(registry.activeCount()).toBe(0);
    registry.dispose();
  });

  test("a session created after timeout still gets bounded cleanup", async () => {
    const registry = new EditorRegistry();
    let resolveCreate!: (value: { id: string }) => void;
    const create = new Promise<{ id: string }>((resolve) => {
      resolveCreate = resolve;
    });
    let deleted = false;
    const ctx = {
      session: {
        create: () => create,
        prompt: async () => undefined,
        wait: async () => undefined,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;
    const result = await runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 1,
        cleanupTimeoutMs: 5,
        deleteSession: () => {
          deleted = true;
          return new Promise<never>(() => {});
        },
      },
      () => "prompt",
    );
    expect(result).toBeNull();
    resolveCreate({ id: "late-editor-session" });
    for (let attempt = 0; !deleted && attempt < 20; attempt += 1)
      await Bun.sleep(1);
    expect(deleted).toBe(true);
    registry.dispose();
  });

  test("does not release a submitted rewrite before session.wait reaches idle", async () => {
    const registry = new EditorRegistry();
    let releaseWait!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    let settled = false;
    const ctx = {
      session: {
        create: async () => ({ id: "waiting-editor-session" }),
        prompt: async () => {
          registry.submit("waiting-editor-session", { prompt: "rewritten" });
        },
        wait: () => waiting,
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;

    const running = runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 1_000,
        deleteSession: async () => undefined,
      },
      () => "rewrite this",
    ).then((result) => {
      settled = true;
      return result;
    });

    await Bun.sleep(0);
    expect(settled).toBe(false);
    releaseWait();
    expect(await running).toEqual({ prompt: "rewritten" });
  });

  test("shutdown releases a submitted run even when session.wait stalls", async () => {
    const registry = new EditorRegistry();
    let submitted!: () => void;
    const didSubmit = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    const deleted: string[] = [];
    const ctx = {
      session: {
        create: async () => ({ id: "shutdown-after-submit" }),
        prompt: async () => {
          registry.submit("shutdown-after-submit", { prompt: "rewritten" });
          submitted();
        },
        wait: () => new Promise<never>(() => {}),
        interrupt: async () => undefined,
      },
    } as unknown as PluginRuntime;
    const running = runEditor(
      ctx,
      {
        registry,
        directory: "/tmp",
        timeoutMs: 30_000,
        deleteSession: async (sessionID) => {
          deleted.push(sessionID);
        },
      },
      () => "prompt",
    );
    await didSubmit;
    registry.beginShutdown();
    expect(await running).toBeNull();
    expect(deleted).toEqual(["shutdown-after-submit"]);
    registry.dispose();
  });

  test("all runs share one shutdown signal without retaining per-run waiters", async () => {
    const registry = new EditorRegistry();
    const first = registry.waitForShutdown();
    const second = registry.waitForShutdown();
    expect(first).toBe(second);
    registry.beginShutdown();
    await expect(first).resolves.toBeUndefined();
    expect(registry.waitForShutdown()).toBe(first);
    registry.dispose();
  });
});

test("event loop reports main-session cancellation independently of editor runs", async () => {
  const registry = new EditorRegistry();
  const cancelled: string[] = [];
  const ctx = {
    event: {
      subscribe: () =>
        (async function* () {
          yield {
            type: "session.execution.interrupted",
            data: { sessionID: "main-session" },
          };
        })(),
    },
  } as unknown as PluginRuntime;
  const loop = startEventLoop(ctx, registry, (sessionID) =>
    cancelled.push(sessionID),
  );
  await loop.loop;
  expect(cancelled).toEqual(["main-session"]);
  await loop.stop();
  registry.dispose();
});

test("event loop termination invokes the fail-closed controller callback", async () => {
  const registry = new EditorRegistry();
  let stopped = 0;
  const ctx = {
    event: {
      subscribe: () =>
        (async function* () {
          yield* [] as never[];
          throw new Error("stream failed");
        })(),
    },
  } as unknown as PluginRuntime;
  const loop = startEventLoop(ctx, registry, undefined, () => {
    stopped += 1;
  });
  await loop.loop;
  expect(stopped).toBe(1);
  await loop.stop();
  registry.dispose();
});

describe("journal", () => {
  test("appends and reads back entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "pe-journal-"));
    const file = join(dir, "journal.jsonl");
    try {
      appendJournal(file, {
        ts: 1,
        sessionID: "s",
        outcome: "rewritten",
        originalLen: 4,
        rewrittenLen: 9,
        durationMs: 5,
      });
      appendJournal(file, {
        ts: 2,
        sessionID: "s",
        outcome: "passthrough",
        durationMs: 0,
      });
      const entries = readJournal(file);
      expect(entries.length).toBe(2);
      expect(entries[0]!.outcome).toBe("rewritten");
      expect(entries[1]!.outcome).toBe("passthrough");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed lines are skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "pe-journal-bad-"));
    const file = join(dir, "journal.jsonl");
    try {
      const { writeFileSync: wfs } = { writeFileSync };
      wfs(file, "{not json}\n", "utf8");
      expect(readJournal(file)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
