import {
  createEditorSession,
  deleteEditorSession,
  interruptEditor,
  promptEditorSession,
  waitForEditorSession,
} from "./editor-session.js";
import { EDITOR_EVENT_FILTER_GRACE_MS } from "./constants.js";
import type { PluginRuntime, SubmitPayload } from "./types.js";

type EventLike = {
  id?: unknown;
  type?: unknown;
  data?: Record<string, unknown>;
};

function comparablePrompt(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/** Normalize raw stream events into { type, sessionID } (mirrors core). */
function normalizeEvent(raw: unknown): { type: string; sessionID?: string } {
  const e = (raw ?? {}) as EventLike;
  const data = e.data ?? {};
  const sessionID =
    typeof data.sessionID === "string" ? data.sessionID : undefined;
  let type = typeof e.type === "string" ? e.type : "unknown";
  const statusType =
    data.status && typeof data.status === "object"
      ? (data.status as Record<string, unknown>)["type"]
      : undefined;
  if (
    (type === "session.idle" ||
      (type === "session.status" && statusType === "idle")) &&
    sessionID
  ) {
    type = "session.execution.succeeded";
  }
  return { type, sessionID };
}

function isTerminal(type: string): boolean {
  return (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted" ||
    type === "session.deleted"
  );
}

interface PendingRun {
  submitted: SubmitPayload | null;
  source: string;
  requireRewrite: boolean;
  /** Single resolver wired once per run (submit tool, event loop, or timeout). */
  setResult: (result: SubmitPayload | null) => void;
  settled: boolean;
}

/**
 * Tracks in-flight editor runs. A run resolves exactly once with either the
 * submitted payload (editor called omni_prompt_submit) or null (session
 * ended without a submit, or a timeout) — fail-open in every null case.
 */
export class EditorRegistry {
  private pending = new Map<string, PendingRun>();
  private editorSessions = new Set<string>();
  private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleWaiters = new Set<() => void>();
  private shuttingDown = false;
  private shutdownResolve!: () => void;
  private readonly shutdownPromise: Promise<void>;

  constructor() {
    this.shutdownPromise = new Promise((resolve) => {
      this.shutdownResolve = resolve;
    });
  }

  attach(
    sessionID: string,
    validation: { source?: string; requireRewrite?: boolean } = {},
  ): void {
    const timer = this.releaseTimers.get(sessionID);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.releaseTimers.delete(sessionID);
    }
    this.editorSessions.add(sessionID);
    const run: PendingRun = {
      submitted: null,
      source: validation.source?.trim() ?? "",
      requireRewrite: validation.requireRewrite === true,
      setResult: () => {},
      settled: this.shuttingDown,
    };
    this.pending.set(sessionID, run);
  }

  /** Rewire the run's resolver to a fresh deferred (called once per run). */
  waitOutcome(sessionID: string): Promise<SubmitPayload | null> {
    const run = this.pending.get(sessionID);
    if (!run) return Promise.resolve(null);
    if (run.settled) return Promise.resolve(null);
    let resolve!: (v: SubmitPayload | null) => void;
    const p = new Promise<SubmitPayload | null>((res) => {
      resolve = res;
    });
    run.setResult = (result) => {
      if (run.settled) return;
      run.settled = true;
      resolve(result);
    };
    return p;
  }

  /** Called by the submit tool when the editor returns its payload. */
  submit(sessionID: string, payload: SubmitPayload): boolean {
    const run = this.pending.get(sessionID);
    if (!run || run.settled) return false;
    if (
      run.requireRewrite &&
      comparablePrompt(payload.prompt) === comparablePrompt(run.source)
    )
      return false;
    run.submitted = payload;
    run.setResult(payload);
    return true;
  }

  /** Called by the terminal executor when a tracked session ends. */
  terminate(sessionID: string): void {
    const run = this.pending.get(sessionID);
    if (run) run.setResult(run.submitted ?? null);
  }

  has(sessionID: string): boolean {
    return this.pending.has(sessionID);
  }

  /** True while the core event consumer must ignore this editor session. */
  isEditorSession(sessionID: string): boolean {
    return this.editorSessions.has(sessionID);
  }

  detach(sessionID: string): void {
    this.pending.delete(sessionID);
    if (this.pending.size === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
    if (!this.editorSessions.has(sessionID)) return;
    const timer = setTimeout(() => {
      this.editorSessions.delete(sessionID);
      this.releaseTimers.delete(sessionID);
    }, EDITOR_EVENT_FILTER_GRACE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.releaseTimers.set(sessionID, timer);
  }

  /** Stop new work and settle every active outcome so runEditor reaches cleanup. */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownResolve();
    for (const run of this.pending.values()) run.setResult(null);
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  waitForIdle(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  /** Stop tracking sessions and release timer handles during plugin shutdown. */
  dispose(): void {
    this.beginShutdown();
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.pending.clear();
    this.editorSessions.clear();
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  /** Best-effort snapshot for diagnostics. */
  activeCount(): number {
    return this.pending.size;
  }
}

/** One global event loop resolving pending editor runs as their sessions end. */
export function startEventLoop(
  ctx: PluginRuntime,
  registry: EditorRegistry,
  onSessionCancelled?: (sessionID: string) => void,
  onLoopStopped?: () => void,
) {
  const ac = new AbortController();
  const loop = (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: ac.signal })) {
        const ev = normalizeEvent(raw);
        if (!ev.sessionID) continue;
        if (
          ev.type === "session.execution.failed" ||
          ev.type === "session.execution.interrupted" ||
          ev.type === "session.deleted"
        )
          onSessionCancelled?.(ev.sessionID);
        if (registry.has(ev.sessionID) && isTerminal(ev.type))
          registry.terminate(ev.sessionID);
      }
    } catch (error) {
      if (!ac.signal.aborted) {
        console.warn(`[prompt-editor] event loop stopped: ${String(error)}`);
      }
    } finally {
      if (!ac.signal.aborted) onLoopStopped?.();
    }
  })();
  return {
    stop: async () => {
      ac.abort();
      await loop;
    },
    loop: loop as Promise<void>,
  };
}

/** Why a run produced no submitted payload. */
export type EditorRunOutcome =
  "timeout" | "error" | "shutdown" | "cancelled" | "empty";

export interface EditorRunDeps {
  registry: EditorRegistry;
  directory: string;
  model?: { providerID: string; id: string; variant?: string };
  originalUserText?: string;
  requireRewrite?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injectable for tests; production uses the server-backed deletion helper. */
  deleteSession?: (sessionID: string) => Promise<void>;
  cleanupTimeoutMs?: number;
  /** Optional telemetry hook reporting why a run produced no payload. */
  onOutcome?: (reason: EditorRunOutcome) => void;
}

/**
 * Runs the editor for one message and returns the submitted payload or null
 * (pass-through on no-submit, error, or timeout).
 */
export async function runEditor(
  ctx: PluginRuntime,
  deps: EditorRunDeps,
  buildPrompt: () => string,
): Promise<SubmitPayload | null> {
  let sessionID: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requestAbort = new AbortController();
  const removeSession = deps.deleteSession ?? deleteEditorSession;
  const cleanupTimeoutMs = deps.cleanupTimeoutMs ?? 4_000;
  const cleanup = async (id: string): Promise<void> => {
    await interruptEditor(ctx, id);
    try {
      const removing = removeSession(id);
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        removing,
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, cleanupTimeoutMs);
          (cleanupTimer as unknown as { unref?: () => void }).unref?.();
        }),
      ]).finally(() => {
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      });
      void removing.catch(() => undefined);
    } catch (error) {
      console.warn(
        `[prompt-editor] editor session cleanup failed: ${String(error)}`,
      );
    }
  };
  // Keep the runner safe even when called directly with an invalid zero value.
  const timeoutMs = Math.max(1, Math.trunc(deps.timeoutMs) || 1);
  const deadline = new Promise<{ type: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      if (sessionID) deps.registry.terminate(sessionID);
      resolve({ type: "timeout" });
      requestAbort.abort();
    }, timeoutMs);
  });
  let removeAbortListener = () => {};
  const cancelled = deps.signal
    ? new Promise<{ type: "cancelled" }>((resolve) => {
        const onAbort = () => {
          resolve({ type: "cancelled" });
          requestAbort.abort();
        };
        if (deps.signal!.aborted) {
          onAbort();
          return;
        }
        deps.signal!.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          deps.signal!.removeEventListener("abort", onAbort);
      })
    : null;
  try {
    const create = createEditorSession(
      ctx,
      {
        directory: deps.directory,
        model: deps.model,
      },
      requestAbort.signal,
    );
    const shutdown = deps.registry
      .waitForShutdown()
      .then(() => ({ type: "shutdown" as const }));
    const createdResult = await Promise.race([
      create.then((created) => ({ type: "created" as const, created })),
      shutdown,
      deadline,
      ...(cancelled ? [cancelled] : []),
    ]);
    if (createdResult.type !== "created") {
      deps.onOutcome?.(createdResult.type);
      void create
        .then(async (late) => {
          const lateID = late.id ?? undefined;
          if (!lateID) return;
          await cleanup(lateID);
        })
        .catch(() => undefined);
      return null;
    }
    const created = createdResult.created;
    sessionID = created.id ?? undefined;
    if (!sessionID) throw new Error("editor session.create returned no id");

    deps.registry.attach(sessionID, {
      source: deps.originalUserText,
      requireRewrite: deps.requireRewrite,
    });
    const outcome = deps.registry.waitOutcome(sessionID);

    if (deps.registry.isShuttingDown()) {
      deps.onOutcome?.("shutdown");
      return null;
    }

    const editorIdle = Promise.resolve()
      .then(async () => {
        await promptEditorSession(
          ctx,
          sessionID!,
          buildPrompt(),
          requestAbort.signal,
        );
        await waitForEditorSession(ctx, sessionID!, requestAbort.signal);
      })
      .then(
        () => ({ type: "idle" as const }),
        (error: unknown) => ({ type: "error" as const, error }),
      );
    const first = await Promise.race([
      editorIdle,
      shutdown,
      deadline,
      ...(cancelled ? [cancelled] : []),
    ]);
    if (first.type === "error") throw first.error;
    if (first.type !== "idle") {
      deps.onOutcome?.(first.type);
      return null;
    }
    // A submit can arrive before the editor turn has fully drained. Only
    // release the caller after session.wait confirms the editor is idle.
    deps.registry.terminate(sessionID);
    const result = await outcome;
    if (!result)
      deps.onOutcome?.(deps.registry.isShuttingDown() ? "shutdown" : "empty");
    return result;
  } catch (error) {
    console.warn(`[prompt-editor] editor run failed: ${String(error)}`);
    deps.onOutcome?.("error");
    return null;
  } finally {
    requestAbort.abort();
    removeAbortListener();
    if (timer !== undefined) clearTimeout(timer);
    if (sessionID) {
      await cleanup(sessionID);
      deps.registry.detach(sessionID);
    }
  }
}
