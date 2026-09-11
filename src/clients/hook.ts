import { installationFingerprint } from "./installer.js";
import { createHash } from "node:crypto";
import type { LocalConfig } from "../cli/config.js";
import { ensureDaemon } from "../cli/daemon.js";
import { sanitizeUntrustedText } from "../telemetry/sanitize.js";
import {
  buildCheckpointContent,
  buildMemoryContextText,
  CONTEXT_FETCH_TIMEOUT_MS,
  CONTEXT_PROMPT_MAX_TOKENS,
  CONTEXT_SESSION_MAX_TOKENS,
  CONTEXT_SPACE_LOOKUP_TIMEOUT_MS,
  isHookEvent,
  parseHookInput,
  promptNeedsContext,
  requestsMemoryOff,
  type ClientName,
  type HookEnvelope,
} from "./hook-contract.js";
import {
  acceptHookCapture,
  consumeTurnMemoryOff,
  deliverSpool,
  peekTurnMemoryOff,
  recordSpoolCounter,
  recordUnsupportedEvent,
  resolveProjectSpaceId,
  setTurnMemoryOff,
} from "./hook-spool.js";
import { resolveProjectBinding } from "./hook-binding.js";
import { fetchMemoryContext } from "./context-client.js";
import {
  beginContextTurn,
  recordContextDelivered,
  recordContextEmpty,
  recordContextFailure,
  recordContextOffered,
} from "./context-state.js";

/**
 * Issue #38 (M05) Faz A hook adapter.
 *
 * The existing UserPromptSubmit/Stop contract is preserved for the visible
 * result: the prompt is never rewritten and the Stop skill handoff payload,
 * source and idempotency stay the same. Memory capture is a separate path
 * (local durable spool) that can never trigger the handoff and vice versa.
 *
 * Hot path rules: no model call, and the memory capture path never calls
 * `ensureDaemon`; it only writes a bounded local spool row.
 */

export interface HookOptions {
  /** Test seam for the bounded spool delivery attempt. */
  fetchImpl?: typeof fetch;
  /** Set false in unit tests that assert capture without delivery. */
  deliver?: boolean;
  /** Context network budget overrides; tests use small values. */
  contextTimeoutMs?: number;
  contextSpaceTimeoutMs?: number;
  /**
   * Test seam invoked with the composed context text before the delivered
   * mark is written. Production uses the default no-op (the hook output is
   * the delivery evidence); a thrown error proves "offered but not delivered".
   */
  contextDelivery?: (
    text: string,
    event: "SessionStart" | "UserPromptSubmit",
  ) => Promise<void>;
}

export async function clientHook(
  config: LocalConfig,
  entry: string,
  client: ClientName,
  projectRef: string,
  input: Record<string, unknown>,
  options: HookOptions = {},
): Promise<object> {
  const eventValue = input.hook_event_name;
  if (
    input.agent_id ||
    input.agent_type ||
    input.stop_hook_active ||
    !isHookEvent(eventValue)
  )
    return {};
  const parsed = parseHookInput(client, eventValue, input);
  if (parsed.kind === "ignored") return {};
  if (parsed.kind === "unsupported") {
    // Known event without an adapter capability: never a success-shaped output.
    await recordUnsupportedEvent(config.dataDir).catch(() => undefined);
    return {};
  }
  const envelope = parsed.envelope;
  const session =
      typeof input.session_id === "string"
        ? input.session_id.slice(0, 200)
        : "unknown",
    turn = typeof input.turn_id === "string" ? input.turn_id.slice(0, 200) : "";
  // Legacy events keep the daemon bootstrap; new events never spawn a daemon
  // from the hook path, and a daemon failure never blocks local capture.
  let daemonReady = false;
  if (envelope.event === "UserPromptSubmit" || envelope.event === "Stop") {
    try {
      await ensureDaemon(config, entry);
      daemonReady = true;
    } catch {
      daemonReady = false;
    }
  }
  if (daemonReady && typeof input.cwd === "string")
    await heartbeat(config, client, projectRef, input.cwd, envelope).catch(
      () => undefined,
    );
  if (envelope.event === "UserPromptSubmit") {
    // Prompt hazırlama kaldırıldı (P22): görünür metin değiştirilmez.
    // Yalnız proje bağlamı ve (gerektiğinde) kaynaklı hafıza kartları ek
    // bağlam olarak taşınır; niyet aynen korunur.
    const memoryOff =
      envelope.prompt !== null && requestsMemoryOff(envelope.prompt);
    await recordTurnDecision(
      config,
      client,
      projectRef,
      envelope,
      memoryOff,
    ).catch(() => undefined);
    await flushSpool(config, options).catch(() => undefined);
    const staticLine = `Skill Forge project_ref: ${projectRef}. Original prompt remains unchanged.`;
    let additionalContext = staticLine;
    if (
      !memoryOff &&
      envelope.prompt !== null &&
      promptNeedsContext(envelope.prompt)
    ) {
      const injected = await injectContext(
        config,
        client,
        projectRef,
        envelope,
        {
          event: "UserPromptSubmit",
          goal: envelope.prompt,
          maxTokens: CONTEXT_PROMPT_MAX_TOKENS,
          options,
        },
      ).catch(() => null);
      if (injected) additionalContext = `${staticLine}\n\n${injected}`;
    }
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
  }
  if (envelope.event === "Stop") {
    const summary = sanitizeUntrustedText(
      typeof input.last_assistant_message === "string"
        ? input.last_assistant_message
        : "",
      6000,
    );
    if (daemonReady && summary.trim()) {
      await deliverStopHandoff(
        config,
        client,
        session,
        turn,
        projectRef,
        summary,
      ).catch(() => undefined);
    }
    await safeCapture(config, () =>
      captureCheckpoint(config, client, projectRef, envelope, summary),
    );
    await flushSpool(config, options).catch(() => undefined);
    return {};
  }
  // SessionStart: sourced, bounded context injection (startup/resume/compact).
  if (envelope.event === "SessionStart") {
    if (!daemonReady && typeof input.cwd === "string")
      await heartbeat(config, client, projectRef, input.cwd, envelope).catch(
        () => undefined,
      );
    const injected = await injectContext(config, client, projectRef, envelope, {
      event: "SessionStart",
      maxTokens: CONTEXT_SESSION_MAX_TOKENS,
      options,
    }).catch(() => null);
    await flushSpool(config, options, 300).catch(() => undefined);
    if (!injected) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: injected,
      },
    };
  }
  // SessionEnd: heartbeat + bounded spool flush, no output.
  if (!daemonReady && typeof input.cwd === "string")
    await heartbeat(config, client, projectRef, input.cwd, envelope).catch(
      () => undefined,
    );
  await flushSpool(config, options).catch(() => undefined);
  return {};
}

async function heartbeat(
  config: LocalConfig,
  client: ClientName,
  projectRef: string,
  cwd: string,
  envelope: HookEnvelope,
) {
  await fetch(`${config.url}/api/installations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: installationFingerprint([client, cwd]),
      project_ref: projectRef,
      client,
      directory: cwd,
      event: envelope.event,
    }),
    signal: AbortSignal.timeout(1000),
  });
}

async function deliverStopHandoff(
  config: LocalConfig,
  client: ClientName,
  session: string,
  turn: string,
  projectRef: string,
  summary: string,
) {
  // Stop offers only a concise visible final summary. Never read transcript_path or private reasoning.
  await fetch(`${config.url}/api/tools/forge_handoff`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      project_ref: projectRef,
      summary,
      idempotency_key: createHash("sha256")
        .update(JSON.stringify([client, session, turn, summary]))
        .digest("hex"),
      source: { client: `${client}-stop-hook`, session },
      evidence: [
        {
          kind: "observation",
          summary:
            "Client final summary received. Its claims require verification; this hook does not certify tests.",
        },
      ],
    }),
    signal: AbortSignal.timeout(2000),
  });
}

async function recordTurnDecision(
  config: LocalConfig,
  client: ClientName,
  projectRef: string,
  envelope: HookEnvelope,
  memoryOff: boolean,
) {
  if (envelope.prompt === null) return;
  if (!envelope.sessionId || !envelope.cwd) return;
  const resolved = await resolveProjectBinding(
    config.dataDir,
    client,
    projectRef,
    envelope.cwd,
  );
  if (resolved.status !== "bound") return;
  const installationId = installationFingerprint([
    client,
    resolved.projectRoot,
  ]);
  await setTurnMemoryOff({
    dataDir: config.dataDir,
    installationId,
    sessionId: envelope.sessionId,
    turnRef: envelope.turnRef,
    memoryOff,
  });
}

async function captureCheckpoint(
  config: LocalConfig,
  client: ClientName,
  projectRef: string,
  envelope: HookEnvelope,
  summary: string,
) {
  if (!summary.trim()) return;
  if (!envelope.sessionId || !envelope.cwd) return;
  const resolved = await resolveProjectBinding(
    config.dataDir,
    client,
    projectRef,
    envelope.cwd,
  );
  if (resolved.status !== "bound") {
    await recordSpoolCounter(config.dataDir, "binding_mismatch");
    return;
  }
  const installationId = installationFingerprint([
    client,
    resolved.projectRoot,
  ]);
  const memoryOff = await consumeTurnMemoryOff({
    dataDir: config.dataDir,
    installationId,
    sessionId: envelope.sessionId,
    turnRef: envelope.turnRef,
  });
  if (memoryOff) return;
  const observedAt = Date.now();
  const content = buildCheckpointContent({
    client,
    sessionId: envelope.sessionId,
    turnRef: envelope.turnRef,
    worktreeKey: resolved.worktreeKey,
    observedAt,
    summary,
  });
  await acceptHookCapture({
    dataDir: config.dataDir,
    installationId,
    projectRef,
    client,
    event: envelope.event,
    sessionId: envelope.sessionId,
    turnRef: envelope.turnRef,
    worktreeKey: resolved.worktreeKey,
    sourceKind: `${client}-stop-hook`,
    kind: "session",
    content,
    observedAt,
  });
}

async function safeCapture(
  config: LocalConfig,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch {
    await recordSpoolCounter(config.dataDir, "capture_error").catch(
      () => undefined,
    );
  }
}

async function flushSpool(
  config: LocalConfig,
  options: HookOptions,
  budgetMs = 750,
) {
  if (options.deliver === false) return;
  // Server-profile hooks are out of Faz A scope; delivery needs the local
  // owner token, while the spool itself always stays local.
  if (config.profile === "server") return;
  await deliverSpool({
    config: {
      dataDir: config.dataDir,
      url: config.url,
      token: config.token,
    },
    fetchImpl: options.fetchImpl,
    budgetMs,
  });
}

/**
 * Fetches the M03 context package and turns it into model-visible text.
 * Offered/delivered bookkeeping happens here; a failed output (seam throws)
 * leaves the revisions unmarked so the next event re-offers them.
 */
async function injectContext(
  config: LocalConfig,
  client: ClientName,
  projectRef: string,
  envelope: HookEnvelope,
  input: {
    event: "SessionStart" | "UserPromptSubmit";
    goal?: string;
    maxTokens: number;
    options: HookOptions;
  },
): Promise<string | null> {
  if (!envelope.sessionId || !envelope.cwd) return null;
  const resolved = await resolveProjectBinding(
    config.dataDir,
    client,
    projectRef,
    envelope.cwd,
  );
  if (resolved.status !== "bound") return null;
  const installationId = installationFingerprint([
    client,
    resolved.projectRoot,
  ]);
  // `[memory:off]` closes injection with the same turn flag as capture.
  const memoryOff = await peekTurnMemoryOff({
    dataDir: config.dataDir,
    installationId,
    sessionId: envelope.sessionId,
    turnRef: envelope.turnRef,
  }).catch(() => false);
  if (memoryOff) return null;
  const spaceTimeout =
    input.options.contextSpaceTimeoutMs ?? CONTEXT_SPACE_LOOKUP_TIMEOUT_MS;
  const fetchTimeout =
    input.options.contextTimeoutMs ?? CONTEXT_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + spaceTimeout + fetchTimeout;
  const turn = await beginContextTurn({
    dataDir: config.dataDir,
    client,
    projectRoot: resolved.projectRoot,
    sessionId: envelope.sessionId,
    worktreeKey: resolved.worktreeKey,
    source: input.event === "SessionStart" ? envelope.source : null,
  });
  const base = {
    dataDir: config.dataDir,
    client,
    projectRoot: resolved.projectRoot,
    sessionKey: turn.sessionKey,
    worktreeKey: turn.worktreeKey,
  };
  const spaceStartedAt = Date.now();
  const spaceId = await resolveProjectSpaceId({
    config: { url: config.url, token: config.token },
    projectRef,
    fetchImpl: input.options.fetchImpl,
    timeoutMs: spaceTimeout,
  }).catch(() => null);
  if (!spaceId) {
    const kind =
      Date.now() - spaceStartedAt >= spaceTimeout - 5 ? "timeout" : "error";
    await recordContextFailure({ ...base, kind }).catch(() => undefined);
    return null;
  }
  const result = await fetchMemoryContext({
    config: { url: config.url, token: config.token },
    spaceId,
    sessionKey: turn.sessionKey,
    generation: turn.generation,
    branch: resolved.workspace.branch,
    worktree: turn.worktreeKey,
    goal: input.goal,
    known: turn.known,
    maxTokens: input.maxTokens,
    fetchImpl: input.options.fetchImpl,
    timeoutMs: fetchTimeout,
    deadline,
  });
  if (result.status === "timeout") {
    await recordContextFailure({ ...base, kind: "timeout" }).catch(
      () => undefined,
    );
    return null;
  }
  if (result.status === "error") {
    await recordContextFailure({ ...base, kind: "error" }).catch(
      () => undefined,
    );
    return null;
  }
  if (result.status === "empty") {
    await recordContextEmpty(base).catch(() => undefined);
    return null;
  }
  const cards = result.package.cards;
  const text = buildMemoryContextText({
    cards,
    continuationNote: result.package.continuation_note,
    truncated: result.package.truncated,
  });
  if (!text) return null;
  const offered = result.package.offered
    .filter((entry) =>
      cards.some(
        (card) =>
          card.note_id === entry.note_id && card.revision === entry.revision,
      ),
    )
    .map((entry) => ({ note_id: entry.note_id, revision: entry.revision }));
  await recordContextOffered({ ...base, count: cards.length });
  await (input.options.contextDelivery?.(text, input.event) ??
    Promise.resolve());
  await recordContextDelivered({
    ...base,
    offered:
      offered.length > 0
        ? offered
        : cards.map((card) => ({
            note_id: card.note_id,
            revision: card.revision,
          })),
    packageHash: result.package.envelope.package_hash,
  });
  return text;
}

export async function readHookInput(
  stream: NodeJS.ReadableStream,
): Promise<Record<string, unknown>> {
  let input = "";
  for await (const chunk of stream) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 1024 * 1024) return {};
  }
  try {
    const value = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
