import type { PromptEditorConfig } from "./config.js";
import { appendLearning } from "./learn.js";
import { appendJournal } from "./journal.js";
import { appendRewrite } from "./rewrites.js";
import { appendState, readSessionFlags } from "./live.js";
import type { PromptEditorRequest } from "./live.js";
import { buildEditorPrompt } from "./system.js";
import {
  collectRuntimeCapabilities,
  type PromptEditorCapabilityCatalog,
} from "./capabilities.js";
import {
  collectContextSnapshot,
  type PromptEditorContextSnapshot,
} from "./context-snapshot.js";
import {
  ApprovalGateRegistry,
  type ApprovalCandidate,
} from "./approval-gate.js";
import {
  runEditor,
  type EditorRegistry,
  type EditorRunDeps,
  type EditorRunOutcome,
} from "./runner.js";
import { persistRewrite } from "./persist.js";
import { SUBMIT_TOOL_NAME, EDITOR_AGENT_ID } from "./constants.js";
import type {
  ChatMessage,
  ContextHookEvent,
  PluginRuntime,
  SubmitPayload,
} from "./types.js";
import {
  collectWorkspaceContext,
  fallbackWorkspaceContext,
  type PromptEditorWorkspaceContext,
} from "./workspace-context.js";

export interface ContextHookDeps {
  cfg: PromptEditorConfig;
  registry: EditorRegistry;
  learnFile: string;
  journalFile: string;
  rewriteFile: string;
  /** Session-scoped runtime flag store (enabled / autoAccept). */
  sessionFlagsFile: string;
  /** Model passed to the editor session (already resolved). */
  model?: { providerID: string; id: string; variant?: string };
  resolveDirectory: (sessionID: string) => Promise<string | null>;
  /** True for sessions the skill-forge/goal ecosystem owns (never rewritten). */
  isExcludedSession: (sessionID: string) => boolean;
  log: (level: "info" | "warn" | "error", message: string) => void;
  /** Test seams; production uses the server-backed implementations. */
  runEditor?: typeof runEditor;
  persistRewrite?: typeof persistRewrite;
  resolveMessageType?: (
    sessionID: string,
    messageID: string,
  ) => Promise<string | null>;
  collectWorkspaceContext?: (
    ctx: PluginRuntime,
    directory: string,
  ) => Promise<PromptEditorWorkspaceContext>;
}

export interface ContextHookController {
  ownsRequest(request: PromptEditorRequest): boolean;
  processRequest(request: PromptEditorRequest): Promise<boolean>;
  cancelSession(sessionID: string): void;
  cancelAll(): void;
  stop(): Promise<void>;
}

interface CacheEntry {
  rewritten: string | null;
  ts: number;
  source: string;
  applied: boolean;
  cancelled?: boolean;
  lifecycle?: {
    candidate: EditorCandidate;
    sessionID: string;
    messageID: string;
    autoAccept: boolean;
    phase: "completed" | "accepted" | "rejected";
    revision?: number;
    gateID?: string;
  };
}

interface EditorCandidate extends ApprovalCandidate {
  startedAt: number;
  durationMs: number;
  directory: string;
  contextSnapshot: PromptEditorContextSnapshot | null;
  capabilities: PromptEditorCapabilityCatalog;
  workspaceContext: PromptEditorWorkspaceContext;
  error?: string;
}

interface InflightEntry {
  promise: Promise<CacheEntry>;
  manual: boolean;
  sessionID: string;
  messageID: string;
  source: string;
  cancellationEpoch: number;
}

interface ManualRun {
  text: string;
  model: { providerID: string; id: string; variant?: string } | undefined;
  directory: string;
  contextSnapshot: PromptEditorContextSnapshot | null;
  capabilities: PromptEditorCapabilityCatalog;
  workspaceContext: PromptEditorWorkspaceContext;
  cancellationEpoch: number;
  candidate: EditorCandidate;
}

const CACHE_MAX = 512;
const RESTART_EXCLUDE_PREFIX = "The server restarted while you were working";
const AGENT_LIST_TTL_MS = 60_000;
const MESSAGE_CLAIM_STATE = Symbol.for(
  "opencode2-skill-forge.prompt-editor-message-claims",
);
const MESSAGE_CLAIM_PROTOCOL = 1;
const MAX_MESSAGE_CLAIMS = 4_096;

interface MessageClaimState {
  protocol: number;
  claims: Map<string, symbol>;
}

interface LocationIdentity {
  directory: string;
  workspaceID?: string;
}

interface AgentModeCache {
  set: Set<string>;
  at: number;
  location?: LocationIdentity;
}

function locationFrom(value: unknown): LocationIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const location = (value as { location?: unknown }).location;
  if (!location || typeof location !== "object") return undefined;
  const directory = (location as { directory?: unknown }).directory;
  if (typeof directory !== "string" || !directory) return undefined;
  const workspaceID = (location as { workspaceID?: unknown }).workspaceID;
  return {
    directory,
    ...(typeof workspaceID === "string" && workspaceID ? { workspaceID } : {}),
  };
}

function sameLocation(
  activation: LocationIdentity | undefined,
  session: LocationIdentity | undefined,
): boolean {
  return (
    activation !== undefined &&
    session !== undefined &&
    activation.directory === session.directory &&
    activation.workspaceID === session.workspaceID
  );
}

function messageClaimState(): MessageClaimState | undefined {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const current = host[MESSAGE_CLAIM_STATE];
  if (current === undefined) {
    const created: MessageClaimState = {
      protocol: MESSAGE_CLAIM_PROTOCOL,
      claims: new Map(),
    };
    host[MESSAGE_CLAIM_STATE] = created;
    return created;
  }
  if (
    !current ||
    typeof current !== "object" ||
    (current as MessageClaimState).protocol !== MESSAGE_CLAIM_PROTOCOL ||
    !((current as MessageClaimState).claims instanceof Map)
  )
    return undefined;
  return current as MessageClaimState;
}

function claimMessage(key: string, owner: symbol): boolean {
  const state = messageClaimState();
  if (!state) return false;
  const existing = state.claims.get(key);
  if (existing && existing !== owner) return false;
  state.claims.delete(key);
  state.claims.set(key, owner);
  while (state.claims.size > MAX_MESSAGE_CLAIMS) {
    const oldest = state.claims.keys().next().value;
    if (typeof oldest !== "string") break;
    state.claims.delete(oldest);
  }
  return true;
}

function releaseMessageClaims(owner: symbol): void {
  const state = messageClaimState();
  if (!state) return;
  for (const [key, claimedBy] of state.claims) {
    if (claimedBy === owner) state.claims.delete(key);
  }
}

/** Grab the user's plain text from a message. Returns null when not text-only-ish. */
export function userText(message: ChatMessage): string | null {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      text += part.text;
    }
  }
  return text === "" ? null : text;
}

/** Replace the text parts of a message (merging into one), keeping media. */
export function applyRewrite(message: ChatMessage, rewritten: string): void {
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: rewritten }];
    return;
  }
  if (!Array.isArray(message.content)) {
    message.content = [{ type: "text", text: rewritten }];
    return;
  }
  const out: Array<Record<string, unknown>> = [];
  let replaced = false;
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      if (!replaced) {
        out.push({ ...part, text: rewritten });
        replaced = true;
      }
      // further text parts are merged into the rewritten one
      continue;
    }
    out.push(part);
  }
  if (!replaced) {
    out.unshift({ type: "text", text: rewritten });
  }
  message.content = out as ChatMessage["content"];
}

export function lastUserMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.id === "string") return m;
  }
  return null;
}

/** Trim-only LRU to keep memory bounded across long service uptimes. */
class LruCache {
  private map = new Map<string, CacheEntry>();
  constructor(private max: number) {}

  get(key: string): CacheEntry | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: CacheEntry): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteSession(sessionID: string): void {
    const prefix = `${sessionID}\u0000`;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }
}

async function isNonPrimaryAgent(
  ctx: PluginRuntime,
  agentID: string | null | undefined,
  cache: AgentModeCache,
): Promise<boolean> {
  if (!agentID) return false;
  const now = Date.now();
  if (cache.at === 0 || now - cache.at > AGENT_LIST_TTL_MS) {
    const fresh = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const listed = ctx.agent.list?.({});
      if (!listed) return true;
      const res = (await Promise.race([
        listed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("agent list timeout")),
            1_500,
          );
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ])) as { data?: unknown };
      if (!Array.isArray(res?.data)) return true;
      for (const a of res.data) {
        if (!a || typeof a !== "object") continue;
        const agent = a as Record<string, unknown>;
        if (agent.mode === "subagent" || agent.hidden === true) {
          if (typeof agent.id === "string") fresh.add(agent.id);
        }
      }
      cache.location = locationFrom(res);
    } catch {
      return true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    cache.set = fresh;
    cache.at = now;
  }
  return cache.set.has(agentID!);
}

/**
 * True when the session is a derived (subagent) session — i.e. it was spawned
 * by another session and therefore carries a parent. Agent-to-agent
 * instructions dispatched to a subagent must never be rewritten by the prompt
 * editor, no matter how the sub-agent is registered. Inspection failures pass
 * the original prompt through unchanged rather than risking a subagent rewrite.
 */
async function inspectSession(
  ctx: PluginRuntime,
  sessionID: string,
  timeoutMs: number,
): Promise<{ derived: boolean; location?: LocationIdentity } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!ctx.session.get) return null;
    const session = await Promise.race([
      ctx.session.get({ sessionID }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
    if (!session) return null;
    const parent =
      (session as { parentID?: unknown; parent_id?: unknown }).parentID ??
      (session as { parentID?: unknown; parent_id?: unknown }).parent_id;
    const location = locationFrom(session);
    return {
      derived: Boolean(parent),
      ...(location ? { location } : {}),
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function inspectMessageType(
  deps: ContextHookDeps,
  sessionID: string,
  messageID: string,
  timeoutMs: number,
): Promise<string | null> {
  if (!deps.resolveMessageType) return "user";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.resolveMessageType(sessionID, messageID).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function registerContextHook(
  ctx: PluginRuntime,
  deps: ContextHookDeps,
): Promise<ContextHookController> {
  const cfg = deps.cfg;
  const cache = new LruCache(CACHE_MAX);
  const inflight = new Map<string, InflightEntry>();
  const manualSessionKeys = new Map<string, string>();
  const approvals = new ApprovalGateRegistry();
  const manualRuns = new Map<string, ManualRun>();
  const cancellationEpochs = new Map<string, number>();
  const runAbortControllers = new Map<string, Set<AbortController>>();
  const agentModeCache: AgentModeCache = { set: new Set<string>(), at: 0 };
  const messageClaimOwner = Symbol("prompt-editor-activation");
  let stopped = false;

  const registerRunAbort = (sessionID: string) => {
    const controller = new AbortController();
    const controllers = runAbortControllers.get(sessionID) ?? new Set();
    controllers.add(controller);
    runAbortControllers.set(sessionID, controllers);
    return {
      controller,
      dispose: () => {
        controllers.delete(controller);
        if (controllers.size === 0) runAbortControllers.delete(sessionID);
      },
    };
  };

  const abortSessionRuns = (sessionID: string) => {
    for (const controller of runAbortControllers.get(sessionID) ?? [])
      controller.abort();
  };

  const abortAllRuns = () => {
    for (const controllers of runAbortControllers.values())
      for (const controller of controllers) controller.abort();
  };

  const keyFor = (sessionID: string, messageID: string) =>
    `${sessionID}\u0000${messageID}`;

  const appendLifecycle = (
    candidate: EditorCandidate,
    sessionID: string,
    messageID: string,
    phase:
      | "completed"
      | "failed"
      | "accepted"
      | "rejected"
      | "awaiting-decision"
      | "re-evaluating"
      | "cancelled",
    autoAccept: boolean,
    revision?: number,
    gateID?: string,
    applied = false,
  ): boolean =>
    appendState({
      protocolVersion: 2,
      ts: Date.now(),
      sessionID,
      messageID,
      phase,
      autoAccept,
      ...(revision !== undefined ? { revision } : {}),
      ...(gateID ? { gateID } : {}),
      applied,
      startedAt: candidate.startedAt,
      durationMs: candidate.durationMs,
      original: candidate.original,
      rewritten: candidate.rewritten ?? undefined,
      model: deps.model ? `${deps.model.providerID}/${deps.model.id}` : null,
      ...(candidate.error ? { error: candidate.error } : {}),
    });

  const runEditorCandidate = async (
    sessionID: string,
    messageID: string,
    text: string,
    model: { providerID: string; id: string; variant?: string } | undefined,
    options: {
      reason?: "auto" | "re-evaluate";
      model?: string | null;
      autoAccept: boolean;
      revision?: number;
      recordStart?: boolean;
      directory?: string;
      contextSnapshot?: PromptEditorContextSnapshot | null;
      capabilities: PromptEditorCapabilityCatalog;
      workspaceContext?: PromptEditorWorkspaceContext;
    },
  ): Promise<EditorCandidate> => {
    const started = Date.now();
    const runAbort = registerRunAbort(sessionID);
    try {
      const reason = options?.reason ?? "auto";
      let directoryTimer: ReturnType<typeof setTimeout> | undefined;
      const directory =
        options.directory ??
        (await Promise.race([
          deps.resolveDirectory(sessionID).catch(() => null),
          new Promise<null>((resolve) => {
            directoryTimer = setTimeout(
              () => resolve(null),
              cfg.directoryTimeoutMs,
            );
            (directoryTimer as unknown as { unref?: () => void }).unref?.();
          }),
        ]).finally(() => {
          if (directoryTimer) clearTimeout(directoryTimer);
        }));
      if (!directory)
        throw new Error("prompt editor session directory unavailable");
      const contextSnapshot = options.contextSnapshot
        ? options.directory
          ? options.contextSnapshot
          : Object.freeze({ ...options.contextSnapshot, directory })
        : null;
      let workspaceTimer: ReturnType<typeof setTimeout> | undefined;
      const workspaceContext =
        options.workspaceContext ??
        (await Promise.race([
          (deps.collectWorkspaceContext ?? collectWorkspaceContext)(
            ctx,
            directory,
          ).catch(() => fallbackWorkspaceContext(directory)),
          new Promise<PromptEditorWorkspaceContext>((resolveWorkspace) => {
            workspaceTimer = setTimeout(
              () => resolveWorkspace(fallbackWorkspaceContext(directory)),
              Math.min(cfg.directoryTimeoutMs, 2_000),
            );
            (workspaceTimer as unknown as { unref?: () => void }).unref?.();
          }),
        ]).finally(() => {
          if (workspaceTimer) clearTimeout(workspaceTimer);
        }));
      if (options.recordStart !== false) {
        const recorded = appendState({
          protocolVersion: 2,
          ts: started,
          sessionID,
          messageID,
          phase: reason === "re-evaluate" ? "re-evaluating" : "editing",
          autoAccept: options.autoAccept,
          ...(options.revision !== undefined
            ? { revision: options.revision }
            : {}),
          startedAt: started,
          original: text,
          model:
            options?.model ??
            (deps.model ? `${deps.model.providerID}/${deps.model.id}` : null),
        });
        if (!recorded && !options.autoAccept)
          throw new Error("prompt editor manual state unavailable");
      }
      let runOutcome: EditorRunOutcome | undefined;
      const runDeps: EditorRunDeps = {
        registry: deps.registry,
        directory,
        model,
        originalUserText: text,
        requireRewrite: cfg.rewriteMode === "always",
        timeoutMs: cfg.timeoutMs,
        cleanupTimeoutMs: cfg.cleanupTimeoutMs,
        signal: runAbort.controller.signal,
        onOutcome: (reason) => {
          runOutcome = reason;
        },
      };
      let payload: SubmitPayload | null = null;
      let error: string | undefined;
      try {
        // Re-evaluations are told to be more careful / look for mistakes.
        const prompt = buildEditorPrompt(
          deps.learnFile,
          text,
          reason === "re-evaluate",
          contextSnapshot,
          cfg,
          options.capabilities,
          workspaceContext,
        );
        payload = await (deps.runEditor ?? runEditor)(
          ctx,
          runDeps,
          () => prompt,
        );
      } catch (e) {
        error = String(e);
      }
      if (!error && !payload && runOutcome && runOutcome !== "empty") {
        error =
          runOutcome === "timeout"
            ? "editor run timed out"
            : runOutcome === "shutdown"
              ? "editor run cancelled by shutdown"
              : runOutcome === "cancelled"
                ? "editor run cancelled"
                : "editor run failed";
      }
      const durationMs = Date.now() - started;
      const rewritten = payload?.prompt?.trim() ? payload.prompt.trim() : null;
      if (error) deps.log("warn", `editor run error: ${error}`);
      return {
        original: text,
        rewritten,
        ...(payload?.learn ? { learn: payload.learn } : {}),
        startedAt: started,
        durationMs,
        directory,
        contextSnapshot,
        capabilities: options.capabilities,
        workspaceContext,
        ...(error ? { error } : {}),
      };
    } finally {
      runAbort.dispose();
    }
  };

  const commitCandidate = async (
    sessionID: string,
    messageID: string,
    candidate: EditorCandidate,
    autoAccept: boolean,
    phase: "completed" | "accepted",
    revision?: number,
    gateID?: string,
  ): Promise<CacheEntry> => {
    const rewritten = candidate.rewritten;
    const entry: CacheEntry = {
      rewritten,
      ts: Date.now(),
      source: candidate.original,
      applied: false,
      ...(rewritten
        ? {
            lifecycle: {
              candidate,
              sessionID,
              messageID,
              autoAccept,
              phase,
              ...(revision !== undefined ? { revision } : {}),
              ...(gateID ? { gateID } : {}),
            },
          }
        : {}),
    };
    cache.set(keyFor(sessionID, messageID), entry);

    if (rewritten) {
      appendRewrite(deps.rewriteFile, {
        ts: Date.now(),
        sessionID,
        messageID,
        outcome: "rewritten",
        original: candidate.original,
        rewritten,
        model: deps.model ? `${deps.model.providerID}/${deps.model.id}` : null,
        durationMs: candidate.durationMs,
        applied: false,
      });
    }
    if (candidate.learn && cfg.learningMode !== "off") {
      const learningCount = appendLearning(
        deps.learnFile,
        candidate.learn,
        cfg.learnMaxBytes,
        cfg.learnEntryMaxChars,
      );
      if (learningCount < 0)
        deps.log("warn", `could not update learn file: ${deps.learnFile}`);
    }

    appendLifecycle(
      candidate,
      sessionID,
      messageID,
      rewritten ? phase : "failed",
      autoAccept,
      revision,
      gateID,
      false,
    );
    appendJournal(deps.journalFile, {
      ts: Date.now(),
      sessionID,
      messageID,
      model: deps.model ? `${deps.model.providerID}/${deps.model.id}` : null,
      outcome: candidate.error
        ? "error"
        : rewritten
          ? "rewritten"
          : "passthrough",
      originalLen: candidate.original.length,
      rewrittenLen: rewritten?.length ?? 0,
      durationMs: candidate.durationMs,
      ...(candidate.error ? { error: candidate.error } : {}),
    });
    return entry;
  };

  const markApplied = (entry: CacheEntry): void => {
    const lifecycle = entry.lifecycle;
    if (!entry.rewritten || entry.applied || !lifecycle) return;
    entry.applied = true;
    appendRewrite(deps.rewriteFile, {
      ts: Date.now(),
      sessionID: lifecycle.sessionID,
      messageID: lifecycle.messageID,
      outcome: "rewritten",
      original: lifecycle.candidate.original,
      rewritten: entry.rewritten,
      model: deps.model ? `${deps.model.providerID}/${deps.model.id}` : null,
      durationMs: lifecycle.candidate.durationMs,
      applied: true,
    });
    appendLifecycle(
      lifecycle.candidate,
      lifecycle.sessionID,
      lifecycle.messageID,
      lifecycle.phase,
      lifecycle.autoAccept,
      lifecycle.revision,
      lifecycle.gateID,
      true,
    );
    if (cfg.persist) {
      void Promise.resolve()
        .then(() =>
          (deps.persistRewrite ?? persistRewrite)({
            sessionID: lifecycle.sessionID,
            messageID: lifecycle.messageID,
            originalText: lifecycle.candidate.original,
            newText: entry.rewritten!,
          }),
        )
        .catch(() => undefined);
    }
  };

  const markCancelled = (entry: CacheEntry): void => {
    if (entry.applied || entry.cancelled) return;
    entry.cancelled = true;
    const lifecycle = entry.lifecycle;
    if (!lifecycle) return;
    cache.delete(keyFor(lifecycle.sessionID, lifecycle.messageID));
    appendLifecycle(
      lifecycle.candidate,
      lifecycle.sessionID,
      lifecycle.messageID,
      "cancelled",
      lifecycle.autoAccept,
      lifecycle.revision,
      lifecycle.gateID,
      false,
    );
  };

  const processMessage = async (
    sessionID: string,
    messageID: string,
    text: string,
    model: { providerID: string; id: string; variant?: string } | undefined,
    autoAccept: boolean,
    contextSnapshot: PromptEditorContextSnapshot | null,
    capabilities: PromptEditorCapabilityCatalog,
    cancellationEpoch: number,
  ): Promise<CacheEntry> => {
    const candidate = await runEditorCandidate(
      sessionID,
      messageID,
      text,
      model,
      {
        autoAccept,
        contextSnapshot,
        capabilities,
      },
    );
    if (
      stopped ||
      (cancellationEpochs.get(sessionID) ?? 0) !== cancellationEpoch
    ) {
      appendLifecycle(candidate, sessionID, messageID, "cancelled", autoAccept);
      throw new Error("prompt editor run cancelled");
    }
    if (autoAccept) {
      const entry = await commitCandidate(
        sessionID,
        messageID,
        candidate,
        true,
        "completed",
        undefined,
        undefined,
      );
      if (
        stopped ||
        (cancellationEpochs.get(sessionID) ?? 0) !== cancellationEpoch
      ) {
        markCancelled(entry);
        throw new Error("prompt editor run cancelled");
      }
      return entry;
    }

    const key = keyFor(sessionID, messageID);
    manualRuns.set(key, {
      text,
      model,
      directory: candidate.directory,
      contextSnapshot: candidate.contextSnapshot,
      capabilities: candidate.capabilities,
      workspaceContext: candidate.workspaceContext,
      cancellationEpoch,
      candidate,
    });
    const snapshot = approvals.open(sessionID, messageID, candidate);
    if (
      !appendLifecycle(
        candidate,
        sessionID,
        messageID,
        "awaiting-decision",
        false,
        snapshot.revision,
        snapshot.gateID,
      )
    ) {
      approvals.cancel(sessionID, messageID);
      approvals.close(sessionID, messageID);
      manualRuns.delete(key);
      throw new Error("prompt editor approval state unavailable");
    }
    const waiting = approvals.wait(sessionID, messageID);
    if (!waiting) throw new Error("prompt editor approval gate disappeared");
    try {
      const decision = await waiting;
      if (decision.kind === "cancel") {
        appendLifecycle(
          candidate,
          sessionID,
          messageID,
          "cancelled",
          false,
          decision.candidate.revision,
          decision.candidate.gateID,
        );
        throw new Error("prompt editor approval cancelled");
      }
      if (decision.kind === "reject") {
        const currentCandidate = manualRuns.get(key)?.candidate ?? candidate;
        const rejected = {
          ...currentCandidate,
          rewritten: decision.candidate.rewritten,
        };
        const entry = {
          rewritten: null,
          ts: Date.now(),
          source: text,
          applied: false,
          lifecycle: {
            candidate: rejected,
            sessionID,
            messageID,
            autoAccept: false,
            phase: "rejected" as const,
            revision: decision.candidate.revision,
            gateID: decision.candidate.gateID,
          },
        };
        cache.set(key, entry);
        appendLifecycle(
          rejected,
          sessionID,
          messageID,
          "rejected",
          false,
          decision.candidate.revision,
          decision.candidate.gateID,
        );
        appendJournal(deps.journalFile, {
          ts: Date.now(),
          sessionID,
          messageID,
          model: deps.model
            ? `${deps.model.providerID}/${deps.model.id}`
            : null,
          outcome: "passthrough",
          originalLen: text.length,
          rewrittenLen: 0,
          durationMs: currentCandidate.durationMs,
        });
        return entry;
      }
      const currentCandidate = manualRuns.get(key)?.candidate ?? candidate;
      const accepted: EditorCandidate = {
        ...currentCandidate,
        rewritten: decision.candidate.rewritten,
        learn: decision.candidate.learn,
      };
      const entry = await commitCandidate(
        sessionID,
        messageID,
        accepted,
        false,
        "accepted",
        decision.candidate.revision,
        decision.candidate.gateID,
      );
      if (
        stopped ||
        (cancellationEpochs.get(sessionID) ?? 0) !== cancellationEpoch
      ) {
        markCancelled(entry);
        throw new Error("prompt editor run cancelled");
      }
      return entry;
    } finally {
      approvals.close(sessionID, messageID);
      manualRuns.delete(key);
    }
  };

  const processRequest = async (
    request: PromptEditorRequest,
  ): Promise<boolean> => {
    const result = approvals.request(request);
    if (
      result.kind === "missing" ||
      result.kind === "stale" ||
      result.kind === "busy"
    ) {
      deps.log(
        "warn",
        `manual decision ${result.kind} for ${request.sessionID} ${request.messageID} r${request.revision}`,
      );
      return false;
    }
    if (result.kind !== "re-evaluate") return true;

    const key = keyFor(request.sessionID, request.messageID);
    const active = manualRuns.get(key);
    if (!active) {
      approvals.cancel(request.sessionID, request.messageID);
      return false;
    }
    const previous = result.candidate;
    if (
      !appendState({
        protocolVersion: 2,
        ts: Date.now(),
        sessionID: request.sessionID,
        messageID: request.messageID,
        phase: "re-evaluating",
        autoAccept: false,
        revision: previous.revision,
        gateID: previous.gateID,
        startedAt: Date.now(),
        original: active.text,
        rewritten: previous.rewritten ?? undefined,
        model: deps.model ? `${deps.model.providerID}/${deps.model.id}` : null,
      })
    ) {
      approvals.cancel(request.sessionID, request.messageID);
      return false;
    }
    const rerun = await runEditorCandidate(
      request.sessionID,
      request.messageID,
      active.text,
      active.model,
      {
        reason: "re-evaluate",
        autoAccept: false,
        revision: previous.revision,
        recordStart: false,
        directory: active.directory,
        contextSnapshot: active.contextSnapshot,
        capabilities: active.capabilities,
        workspaceContext: active.workspaceContext,
      },
    );
    const nextCandidate: EditorCandidate = {
      ...rerun,
      rewritten: rerun.rewritten ?? previous.rewritten,
      learn: rerun.learn ?? previous.learn,
    };
    active.candidate = nextCandidate;
    const next = approvals.finishReevaluation(
      request.sessionID,
      request.messageID,
      previous.revision,
      nextCandidate,
    );
    if (!next) return false;
    if (
      !appendLifecycle(
        nextCandidate,
        request.sessionID,
        request.messageID,
        "awaiting-decision",
        false,
        next.revision,
        next.gateID,
      )
    ) {
      approvals.cancel(request.sessionID, request.messageID);
      return false;
    }
    return true;
  };

  const hookRegistration = await ctx.session.hook(
    "context",
    async (event: ContextHookEvent) => {
      if (stopped) return;
      const isEditorSession =
        deps.registry.has(event.sessionID) || event.agent === EDITOR_AGENT_ID;
      // Tool hygiene: keep the submit tool only inside editor sessions; cap the
      // editor session's tools to the allowlist.
      if (isEditorSession) {
        const keep = new Set([...cfg.tools, SUBMIT_TOOL_NAME]);
        for (const name of Object.keys(event.tools)) {
          if (!keep.has(name)) delete event.tools[name];
        }
      } else {
        delete event.tools[SUBMIT_TOOL_NAME];
      }

      if (!cfg.enabled) return;
      if (isEditorSession) return;
      if (event.agent === "spr" || event.agent === "omni-spr") return;
      if (deps.isExcludedSession(event.sessionID)) return;
      if (await isNonPrimaryAgent(ctx, event.agent, agentModeCache)) return;
      if (stopped) return;
      const flags = readSessionFlags(deps.sessionFlagsFile, event.sessionID, {
        enabled: cfg.defaultSessionEnabled,
        autoAccept: cfg.defaultAutoAccept,
      });
      if (!flags.enabled) return;
      // Never rewrite an agent-to-agent instruction: subagent/derived sessions
      // always carry a parent session, so their prompts must pass through
      // untouched regardless of how the sub-agent was registered.
      const session = await inspectSession(
        ctx,
        event.sessionID,
        cfg.directoryTimeoutMs,
      );
      if (
        !session ||
        session.derived ||
        !sameLocation(agentModeCache.location, session.location)
      )
        return;
      if (stopped) return;

      const message = lastUserMessage(event.messages);
      if (!message) return;
      const text = userText(message);
      if (!text) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("/")) return;
      if (trimmed.length < cfg.minChars) return;
      // Oversized targets cannot be refined within the deadline; pass them
      // through immediately instead of stalling until timeoutMs.
      if (trimmed.length > cfg.maxChars) return;
      if (trimmed.startsWith(RESTART_EXCLUDE_PREFIX)) return;
      // Never rewrite an agent-to-agent instruction, even when it is embedded
      // in the message body (e.g. a serialized <subagent …> call): treat such
      // payloads as data that must pass through untouched.
      if (/<\/?subagent[\s>]/.test(trimmed) || trimmed.includes("</subagent>"))
        return;

      const messageID = message.id ?? null;
      if (!messageID) return;
      // OpenCode lowers synthetic, shell, and compaction records to user-role
      // model messages. Only a durable `user` record is operator-authored.
      if (
        (await inspectMessageType(
          deps,
          event.sessionID,
          messageID,
          Math.min(cfg.directoryTimeoutMs, 2_000),
        )) !== "user"
      )
        return;

      const key = keyFor(event.sessionID, messageID);
      if (!claimMessage(key, messageClaimOwner)) return;
      // Capture immutable same-event evidence before any asynchronous editor work.
      // The exact session directory is attached after resolveDirectory completes.
      const contextSnapshot = collectContextSnapshot(
        event.messages,
        message,
        "",
        cfg,
      );
      const capabilities = collectRuntimeCapabilities(event.tools);
      const cached = cache.get(key);
      if (
        cached &&
        (cached.source === text ||
          (cached.rewritten !== null && cached.rewritten === text))
      ) {
        if (cached.applied && cached.rewritten && cached.source === text)
          applyRewrite(message, cached.rewritten);
        return;
      }
      if (cached?.lifecycle?.autoAccept === false)
        throw new Error("prompt editor source changed after manual decision");
      const pending = inflight.get(key);
      if (pending) {
        // Another request already runs the editor for this exact message.
        if (pending.manual || cfg.blocking) {
          let entry: CacheEntry;
          try {
            entry = await pending.promise;
          } catch (error) {
            if (pending.manual) throw error;
            return;
          }
          if (
            stopped ||
            (cancellationEpochs.get(event.sessionID) ?? 0) !==
              pending.cancellationEpoch
          ) {
            if (pending.manual) throw new Error("prompt editor run cancelled");
            return;
          }
          const currentText = userText(message);
          if (entry.cancelled) {
            if (pending.manual) throw new Error("prompt editor run cancelled");
            return;
          }
          const alreadyApplied =
            entry.applied &&
            entry.rewritten !== null &&
            currentText === entry.rewritten;
          if (
            pending.manual &&
            currentText !== entry.source &&
            !alreadyApplied
          ) {
            markCancelled(entry);
            throw new Error(
              "prompt editor source changed while awaiting approval",
            );
          }
          if (
            !alreadyApplied &&
            entry.rewritten &&
            currentText === entry.source
          ) {
            applyRewrite(message, entry.rewritten);
            markApplied(entry);
          }
        }
        // Non-blocking: pass through immediately (fail-open); the background
        // run still records its unapplied candidate for display/learning.
        return;
      }

      const cancellationEpoch = cancellationEpochs.get(event.sessionID) ?? 0;
      if (!flags.autoAccept) {
        const activeKey = manualSessionKeys.get(event.sessionID);
        if (activeKey && activeKey !== key)
          throw new Error("prompt editor approval already pending for session");
        manualSessionKeys.set(event.sessionID, key);
      }
      const record = processMessage(
        event.sessionID,
        messageID,
        text,
        deps.model,
        flags.autoAccept,
        contextSnapshot,
        capabilities,
        cancellationEpoch,
      );
      inflight.set(key, {
        promise: record,
        manual: !flags.autoAccept,
        sessionID: event.sessionID,
        messageID,
        source: text,
        cancellationEpoch,
      });
      if (!flags.autoAccept || cfg.blocking) {
        // Real-time/manual mode: the runner owns the end-to-end editor deadline.
        try {
          const entry = await record;
          if (
            stopped ||
            (cancellationEpochs.get(event.sessionID) ?? 0) !== cancellationEpoch
          ) {
            markCancelled(entry);
            if (!flags.autoAccept)
              throw new Error("prompt editor run cancelled");
            return;
          }
          const currentText = userText(message);
          if (entry.cancelled) {
            if (!flags.autoAccept)
              throw new Error("prompt editor run cancelled");
            return;
          }
          const alreadyApplied =
            entry.applied &&
            entry.rewritten !== null &&
            currentText === entry.rewritten;
          if (
            !flags.autoAccept &&
            currentText !== entry.source &&
            !alreadyApplied
          ) {
            markCancelled(entry);
            throw new Error(
              "prompt editor source changed while awaiting approval",
            );
          }
          if (
            !alreadyApplied &&
            entry.rewritten &&
            currentText === entry.source
          ) {
            applyRewrite(message, entry.rewritten);
            markApplied(entry);
          }
        } catch (error) {
          if (!flags.autoAccept) throw error;
        } finally {
          inflight.delete(key);
          if (manualSessionKeys.get(event.sessionID) === key)
            manualSessionKeys.delete(event.sessionID);
        }
        return;
      }
      // Default non-blocking: never freeze the conversation. The original
      // message passes through as-is; the editor runs in the background and the
      // improved prompt is recorded (rewrites.jsonl / learn.md / journal /
      // part.update where supported) for display and future context reads.
      void record.catch(() => {}).finally(() => inflight.delete(key));
    },
  );
  let hookDisposal: Promise<void> | undefined;
  const disposeHook = (): Promise<void> => {
    if (!hookDisposal) {
      hookDisposal = (async () => {
        if (
          hookRegistration &&
          typeof hookRegistration === "object" &&
          "dispose" in hookRegistration &&
          typeof hookRegistration.dispose === "function"
        )
          await hookRegistration.dispose();
      })();
    }
    return hookDisposal;
  };
  return {
    ownsRequest(request) {
      return approvals.owns(request);
    },
    processRequest,
    cancelSession(sessionID) {
      cancellationEpochs.set(
        sessionID,
        (cancellationEpochs.get(sessionID) ?? 0) + 1,
      );
      cache.deleteSession(sessionID);
      abortSessionRuns(sessionID);
      for (const entry of inflight.values()) {
        if (entry.sessionID !== sessionID || !entry.manual) continue;
        appendState({
          protocolVersion: 2,
          ts: Date.now(),
          sessionID,
          messageID: entry.messageID,
          phase: "cancelled",
          autoAccept: false,
          applied: false,
          original: entry.source,
          error: "session_cancelled",
        });
      }
      approvals.cancelSession(sessionID);
    },
    cancelAll() {
      stopped = true;
      abortAllRuns();
      for (const sessionID of manualSessionKeys.keys())
        cancellationEpochs.set(
          sessionID,
          (cancellationEpochs.get(sessionID) ?? 0) + 1,
        );
      approvals.cancelAll();
    },
    async stop() {
      stopped = true;
      abortAllRuns();
      for (const sessionID of manualSessionKeys.keys())
        cancellationEpochs.set(
          sessionID,
          (cancellationEpochs.get(sessionID) ?? 0) + 1,
        );
      approvals.cancelAll();
      await Promise.allSettled(
        [...inflight.values()].map((entry) => entry.promise),
      );
      try {
        await disposeHook();
      } finally {
        releaseMessageClaims(messageClaimOwner);
      }
    },
  };
}
