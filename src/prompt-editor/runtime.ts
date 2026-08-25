import type { ContextHookController } from "./context-hook.js";
import type { PromptEditorRequest } from "./live.js";

const PROMPT_EDITOR_RUNTIME_PROTOCOL = 1;
export const PROMPT_EDITOR_RUNTIME_STATE = Symbol.for(
  "opencode2-skill-forge.prompt-editor-runtime",
);

interface RequestPoller {
  poll(): Promise<void>;
  stop(): Promise<void>;
}

interface PromptEditorRuntimeState {
  protocol: number;
  controllers: Set<ContextHookController>;
  bootstrapping: number;
  orphanSweepClaimed: boolean;
  poller?: RequestPoller;
  pollerStopping?: Promise<void>;
}

function resetOrphanSweepIfIdle(runtime: PromptEditorRuntimeState): void {
  if (
    runtime.controllers.size === 0 &&
    runtime.bootstrapping === 0 &&
    runtime.poller === undefined &&
    runtime.pollerStopping === undefined
  )
    runtime.orphanSweepClaimed = false;
}

export interface PromptEditorRuntimeRegistration {
  claimOrphanSweep(): boolean;
  ensurePoller(create: () => RequestPoller): Promise<void>;
  route(request: PromptEditorRequest): Promise<void>;
  release(): Promise<void>;
}

export interface PromptEditorRuntimeBootstrap {
  attach(controller: ContextHookController): PromptEditorRuntimeRegistration;
  abort(): void;
}

function state(): PromptEditorRuntimeState | undefined {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const current = host[PROMPT_EDITOR_RUNTIME_STATE];
  if (current === undefined) {
    const created: PromptEditorRuntimeState = {
      protocol: PROMPT_EDITOR_RUNTIME_PROTOCOL,
      controllers: new Set(),
      bootstrapping: 0,
      orphanSweepClaimed: false,
    };
    host[PROMPT_EDITOR_RUNTIME_STATE] = created;
    return created;
  }
  if (
    !current ||
    typeof current !== "object" ||
    (current as PromptEditorRuntimeState).protocol !==
      PROMPT_EDITOR_RUNTIME_PROTOCOL ||
    typeof (current as PromptEditorRuntimeState).bootstrapping !== "number" ||
    !((current as PromptEditorRuntimeState).controllers instanceof Set)
  )
    return undefined;
  return current as PromptEditorRuntimeState;
}

function attachController(
  runtime: PromptEditorRuntimeState,
  controller: ContextHookController,
): PromptEditorRuntimeRegistration {
  runtime.controllers.add(controller);
  let released = false;
  return {
    claimOrphanSweep() {
      if (runtime.orphanSweepClaimed) return false;
      runtime.orphanSweepClaimed = true;
      return true;
    },
    async ensurePoller(create) {
      while (runtime.pollerStopping) {
        try {
          await runtime.pollerStopping;
        } catch {
          // The releasing activation reports the stop failure; retry handoff.
        }
      }
      if (runtime.poller || released || !runtime.controllers.has(controller))
        return;
      runtime.poller = create();
    },
    async route(request) {
      for (const candidate of runtime.controllers) {
        if (!candidate.ownsRequest(request)) continue;
        if (!(await candidate.processRequest(request)))
          throw new Error(
            "prompt editor request owner could not process decision",
          );
        return;
      }
      if (runtime.bootstrapping > 0)
        throw new Error("prompt editor activation is still bootstrapping");
      // No live owner means a fenced stale request; acknowledging it is safe.
    },
    async release() {
      if (released) return;
      released = true;
      runtime.controllers.delete(controller);
      if (runtime.controllers.size > 0) return;
      if (runtime.poller) {
        const poller = runtime.poller;
        runtime.poller = undefined;
        const stopping = Promise.resolve().then(() => poller.stop());
        runtime.pollerStopping = stopping;
        let stopFailed = false;
        let stopError: unknown;
        try {
          await stopping;
        } catch (error) {
          stopFailed = true;
          stopError = error;
        } finally {
          if (runtime.pollerStopping === stopping)
            runtime.pollerStopping = undefined;
        }
        resetOrphanSweepIfIdle(runtime);
        if (stopFailed) throw stopError;
      }
      resetOrphanSweepIfIdle(runtime);
    },
  };
}

export function beginPromptEditorActivation(): PromptEditorRuntimeBootstrap | null {
  const runtime = state();
  if (!runtime) return null;
  runtime.bootstrapping += 1;
  let pending = true;
  return {
    attach(controller) {
      if (!pending) throw new Error("prompt editor activation already settled");
      pending = false;
      runtime.bootstrapping -= 1;
      return attachController(runtime, controller);
    },
    abort() {
      if (!pending) return;
      pending = false;
      runtime.bootstrapping -= 1;
      resetOrphanSweepIfIdle(runtime);
    },
  };
}
