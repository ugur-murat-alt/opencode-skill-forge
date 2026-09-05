import { resolvePromptEditorOptions } from "./config.js";
import { registerContextHook, type ContextHookDeps } from "./context-hook.js";
import { EditorRegistry, startEventLoop } from "./runner.js";
import { resolveStoredMessageType } from "./editor-session.js";
import { registerSubmitTool } from "./submit-tool.js";
import {
  loadEditorAgentConfig,
  registerEditorAgent,
  resolveAgentModel,
} from "./agent.js";
import { defaultLearnFile, journalFile } from "./paths.js";
import { rewritesFile } from "./rewrites.js";
import {
  acknowledgeRequest,
  sessionFlagsFile,
  requestsFile,
  readRequests,
  cancelOrphanedManualStates,
  type PromptEditorRequest,
} from "./live.js";
import { isHostIsolatedSession } from "./external.js";
import { appendJournal } from "./journal.js";
import type { PluginRuntime } from "./types.js";
import {
  beginPromptEditorActivation,
  type PromptEditorRuntimeRegistration,
} from "./runtime.js";

/** How often the re-evaluate/decision request file is polled (ms). */
const PROMPT_EDITOR_REQUEST_POLL_MS = 2_000;

interface DisposableRegistration {
  dispose(): Promise<void>;
}

function rememberRegistration(
  registrations: DisposableRegistration[],
  value: unknown,
): void {
  if (
    value &&
    typeof value === "object" &&
    "dispose" in value &&
    typeof value.dispose === "function"
  )
    registrations.push(value as DisposableRegistration);
}

async function disposeRegistrations(
  registrations: DisposableRegistration[],
): Promise<void> {
  while (registrations.length > 0) {
    const registration = registrations.pop();
    if (!registration) continue;
    try {
      await registration.dispose();
    } catch {
      // best-effort rollback and teardown
    }
  }
}

async function waitWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Registers the prompt-editor subsystem. Returns a cleanup function, or
 * undefined when the subsystem is disabled via `options.promptEditor.enabled`.
 * Independent of the skill-forge master `enabled` flag.
 */
export function setupPromptEditor(
  ctx: PluginRuntime,
  suppliedRegistry?: EditorRegistry,
) {
  let cfg;
  try {
    cfg = resolvePromptEditorOptions(ctx.options);
  } catch (error) {
    console.error(
      `[prompt-editor] config invalid, subsystem disabled: ${String(error)}`,
    );
    return undefined;
  }
  if (!cfg.enabled) return undefined;

  let agentCfg;
  try {
    agentCfg = loadEditorAgentConfig(import.meta.url);
  } catch (error) {
    console.error(
      `[prompt-editor] could not load agent config, subsystem disabled: ${String(error)}`,
    );
    return undefined;
  }

  const registry = suppliedRegistry ?? new EditorRegistry();
  const learnFile = cfg.learnFile ?? defaultLearnFile();
  const journal = journalFile();
  let model: ReturnType<typeof resolveAgentModel>;
  try {
    model = resolveAgentModel(cfg, agentCfg);
  } catch (error) {
    console.error(
      `[prompt-editor] invalid model, subsystem disabled: ${String(error)}`,
    );
    return undefined;
  }
  const runtimeBootstrap = beginPromptEditorActivation();
  if (!runtimeBootstrap) {
    console.error(
      "[prompt-editor] incompatible process runtime, subsystem disabled",
    );
    return undefined;
  }

  const log = (level: "info" | "warn" | "error", message: string) =>
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
      `[prompt-editor] ${message}`,
    );

  const deps: ContextHookDeps = {
    cfg,
    registry,
    learnFile,
    journalFile: journal,
    rewriteFile: rewritesFile(),
    sessionFlagsFile: sessionFlagsFile(),
    model,
    resolveDirectory: async (sessionID) => {
      try {
        const session = await ctx.session.get?.({ sessionID });
        return session?.location?.directory ?? null;
      } catch {
        return null;
      }
    },
    resolveMessageType: async (sessionID, messageID) => {
      if (!ctx.session.message)
        return resolveStoredMessageType(sessionID, messageID);
      try {
        return (
          (await ctx.session.message({ sessionID, messageID })).type ?? null
        );
      } catch {
        return null;
      }
    },
    isExcludedSession: (sessionID) => isHostIsolatedSession(sessionID),
    log,
  };

  let eventLoop: ReturnType<typeof startEventLoop> | undefined;
  let contextHook: Awaited<ReturnType<typeof registerContextHook>> | undefined;
  let runtimeRegistration: PromptEditorRuntimeRegistration | null = null;
  const registrations: DisposableRegistration[] = [];
  let stopping = false;

  const stopPartialSetup = async () => {
    runtimeBootstrap.abort();
    contextHook?.cancelAll();
    registry.beginShutdown();
    try {
      await runtimeRegistration?.release();
    } catch {
      // best-effort
    }
    try {
      await contextHook?.stop();
    } catch {
      // best-effort
    }
    try {
      await eventLoop?.stop();
    } catch {
      // best-effort
    }
    await disposeRegistrations(registrations);
  };

  const bootstrap = (async () => {
    try {
      rememberRegistration(
        registrations,
        await registerEditorAgent(ctx, cfg, agentCfg),
      );
      if (stopping) return void (await stopPartialSetup());
      rememberRegistration(
        registrations,
        await registerSubmitTool(
          ctx,
          {
            submit: (sessionID, payload) => registry.submit(sessionID, payload),
          },
          cfg,
        ),
      );
      if (stopping) return void (await stopPartialSetup());
      contextHook = await registerContextHook(ctx, deps);
      if (stopping) return void (await stopPartialSetup());
      runtimeRegistration = runtimeBootstrap.attach(contextHook);
      if (runtimeRegistration.claimOrphanSweep()) {
        const orphaned = cancelOrphanedManualStates();
        if (orphaned > 0)
          log("warn", `cancelled ${orphaned} orphaned manual approval gate(s)`);
      }
      eventLoop = startEventLoop(
        ctx,
        registry,
        (sessionID) => contextHook?.cancelSession(sessionID),
        () => contextHook?.cancelAll(),
      );
      await runtimeRegistration.ensurePoller(() =>
        startRequestPoller(log, {
          process: (request) => runtimeRegistration!.route(request),
        }),
      );
      if (stopping) return void (await stopPartialSetup());
      appendJournal(journal, {
        ts: Date.now(),
        sessionID: "",
        outcome: "setup",
        durationMs: 0,
        model: model ? `${model.providerID}/${model.id}` : null,
      });
      log(
        "info",
        `subsystem ready (model=${model ? `${model.providerID}/${model.id}` : "default"}, steps=${cfg.maxSteps}, timeout=${cfg.timeoutMs}ms, learn=${learnFile})`,
      );
    } catch (error) {
      await stopPartialSetup();
      if (!stopping) log("error", `setup failed: ${String(error)}`);
    }
  })();

  return async () => {
    await waitWithin(bootstrap, 1_000);
    stopping = true;
    runtimeBootstrap.abort();
    registry.beginShutdown();
    contextHook?.cancelAll();
    await stopPartialSetup();
    await registry.waitForIdle().catch(() => undefined);
    registry.dispose();
  };
}

interface RequestPollerOptions {
  pollMs?: number;
  initialDelayMs?: number;
  read?: () => PromptEditorRequest[];
  process?: (request: PromptEditorRequest) => Promise<void>;
  acknowledge?: (request: PromptEditorRequest) => boolean;
}

/**
 * Polls the versioned request control file for decisions coming from the web
 * bridge. The context-hook approval registry is the only release authority;
 * this JSONL poller is transport and serialization only.
 */
export function startRequestPoller(
  log: (level: "info" | "warn" | "error", message: string) => void,
  options: RequestPollerOptions = {},
): { poll(): Promise<void>; stop(): Promise<void> } {
  const seen = new Set<string>();
  const read =
    options.read ?? (() => readRequests(requestsFile(), seen, false));
  const process =
    options.process ??
    (async (request: PromptEditorRequest) => {
      log(
        "warn",
        `decision ignored without an approval controller for ${request.sessionID} ${request.messageID}`,
      );
    });
  const acknowledge =
    options.acknowledge ?? (options.read ? () => true : acknowledgeRequest);
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let tail = Promise.resolve();

  const poll = (): Promise<void> => {
    if (stopped) return tail;
    const run = async () => {
      try {
        for (const request of read()) {
          await process(request);
          if (!acknowledge(request))
            throw new Error("prompt editor request acknowledgement failed");
          seen.add(
            `${request.kind}|${request.sessionID}|${request.messageID}|${request.gateID}|${request.revision}|${request.ts}`,
          );
        }
      } catch {
        // best-effort
      }
    };
    tail = tail.then(run, run);
    return tail;
  };

  timer = setInterval(() => {
    void poll();
  }, options.pollMs ?? PROMPT_EDITOR_REQUEST_POLL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  // Fire-once shortly after startup so pending requests are honoured.
  const immediate = setTimeout(() => {
    void poll();
  }, options.initialDelayMs ?? 500);
  (immediate as unknown as { unref?: () => void }).unref?.();

  return {
    poll,
    async stop() {
      if (!stopped) {
        stopped = true;
        if (timer !== undefined) clearInterval(timer);
        clearTimeout(immediate);
      }
      await tail;
    },
  };
}
