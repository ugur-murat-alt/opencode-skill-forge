import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { promptEditorStateDir } from "./paths.js";

/**
 * Live prompt-editor state: editing progress, completion, and the per-session
 * runtime decision/flag surface that the web UI reads through the bridge.
 *
 * Unlike `rewrites.jsonl` (completed rewrites only), `states.jsonl` records the
 * full lifecycle of each editor run (started / completed / decision) so the UI
 * can show a working indicator, elapsed time, the improved prompt, and the
 * Yes / No / Re-evaluate confirmation.
 *
 * `session-flags.json` holds SESSION-SCOPED runtime flags (editor enabled and
 * auto-accept). Both default to true; they are per-session, not global config.
 *
 * `requests.jsonl` is a small control channel: the bridge can enqueue a
 * "re-evaluate" request and the plugin poller re-runs the editor for it.
 */

export type PromptEditorStatePhase =
  | "editing"
  | "completed"
  | "failed"
  | "accepted"
  | "rejected"
  | "re-evaluating"
  | "awaiting-decision"
  | "cancelled";

export interface PromptEditorStateRecord {
  protocolVersion?: 2;
  ts: number;
  sessionID: string;
  messageID: string;
  phase: PromptEditorStatePhase;
  /** Candidate generation used to reject stale or conflicting web decisions. */
  revision?: number;
  /** Process-unique gate identity; revisions alone are reusable after restart. */
  gateID?: string;
  /** Immutable per-message policy snapshot; later flag changes affect only new messages. */
  autoAccept?: boolean;
  /** Whether this rewrite was applied to the provider dispatch being intercepted. */
  applied?: boolean;
  /** Editor run start time (for the elapsed timer in the UI). */
  startedAt?: number;
  /** Duration of the editor run. */
  durationMs?: number;
  original?: string;
  rewritten?: string;
  model?: string | null;
  error?: string;
}

export interface PromptEditorSessionFlags {
  /** Prompt editor on/off for this session (runtime, default true). */
  enabled: boolean;
  /** Auto-accept rewrites (skip the Yes/No/Re-evaluate confirmation). */
  autoAccept: boolean;
}

export type PromptEditorRequest = {
  protocolVersion: 2;
  kind: "re-evaluate" | "accept" | "reject";
  sessionID: string;
  messageID: string;
  gateID: string;
  revision: number;
  ts: number;
};

export const PROMPT_EDITOR_FLAG_DEFAULTS: PromptEditorSessionFlags = {
  enabled: true,
  autoAccept: true,
};

export const PROMPT_EDITOR_STATES_LIMIT = 400;

export function statesFile(): string {
  return joinState("states.jsonl");
}

export function sessionFlagsFile(): string {
  return joinState("session-flags.json");
}

export function requestsFile(): string {
  // Keep v2 decisions away from the pre-gate poller used by version 0.3.3.
  return joinState("requests-v2.jsonl");
}

export function requestAcksFile(): string {
  return joinState("requests-v2-acks.jsonl");
}

export function promptEditorRequestIdentity(
  request: PromptEditorRequest,
): string {
  return `${request.kind}|${request.sessionID}|${request.messageID}|${request.gateID}|${request.revision}|${request.ts}`;
}

export function acknowledgeRequest(request: PromptEditorRequest): boolean {
  try {
    const file = requestAcksFile();
    ensureParent(file);
    let existing = "";
    try {
      existing = readFileSync(file, "utf8");
    } catch {
      // New acknowledgement journal.
    }
    const kept = existing.split("\n").filter(Boolean).slice(-999);
    const line = JSON.stringify(promptEditorRequestIdentity(request));
    writeFileSync(
      file,
      kept.length > 0 ? `${kept.join("\n")}\n${line}\n` : `${line}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return true;
  } catch {
    // A missing acknowledgement only causes a safe retry of the fenced request.
    return false;
  }
}

function joinState(name: string): string {
  return `${promptEditorStateDir()}/${name}`;
}

function ensureParent(file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    // best-effort
  }
}

/**
 * Append a lifecycle state record (newest last), trimming the file to a
 * bounded size. Fail-open: never throws into the message pipeline.
 */
function stateKey(entry: PromptEditorStateRecord): string {
  return `${entry.sessionID}|${entry.messageID}`;
}

export function isActiveManualState(entry: PromptEditorStateRecord): boolean {
  return (
    entry.protocolVersion === 2 &&
    entry.autoAccept === false &&
    (entry.phase === "editing" ||
      entry.phase === "awaiting-decision" ||
      entry.phase === "re-evaluating")
  );
}

export function appendState(entry: PromptEditorStateRecord): boolean {
  const file = statesFile();
  try {
    ensureParent(file);
    let existing = "";
    try {
      existing = readFileSync(file, "utf8");
    } catch {
      // new file
    }
    const records: PromptEditorStateRecord[] = [];
    for (const line of existing.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as PromptEditorStateRecord;
        if (
          parsed &&
          typeof parsed.sessionID === "string" &&
          typeof parsed.messageID === "string"
        )
          records.push(parsed);
      } catch {
        // Drop malformed telemetry while rewriting the bounded file.
      }
    }
    records.push(entry);

    const latestIndex = new Map<string, number>();
    records.forEach((record, index) =>
      latestIndex.set(stateKey(record), index),
    );
    const protectedIndexes = new Set(
      [...latestIndex.values()].filter((index) =>
        isActiveManualState(records[index]!),
      ),
    );
    const selected = new Set<number>();
    for (const index of [...protectedIndexes].sort((a, b) => b - a)) {
      if (selected.size >= PROMPT_EDITOR_STATES_LIMIT) break;
      selected.add(index);
    }
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (selected.size >= PROMPT_EDITOR_STATES_LIMIT) break;
      selected.add(index);
    }
    const content = [...selected]
      .sort((a, b) => a - b)
      .map((index) => JSON.stringify(records[index]))
      .join("\n");
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, content ? `${content}\n` : "", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, file);
    return true;
  } catch {
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function readStates(
  file: string,
  limit = PROMPT_EDITOR_STATES_LIMIT,
): PromptEditorStateRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: PromptEditorStateRecord[] = [];
  for (const line of raw.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PromptEditorStateRecord;
      if (
        parsed &&
        typeof parsed.sessionID === "string" &&
        typeof parsed.messageID === "string"
      ) {
        out.push(parsed);
        if (out.length >= limit) break;
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** Latest record per (sessionID|messageID), newest wins. */
export function latestStatesPerMessage(
  file: string,
): Map<string, PromptEditorStateRecord> {
  const map = new Map<string, PromptEditorStateRecord>();
  const filePath = file;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return map;
  }
  // Iterate oldest -> newest so later records overwrite earlier ones for the
  // same key, leaving the newest phase per message.
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PromptEditorStateRecord;
      if (
        parsed &&
        typeof parsed.sessionID === "string" &&
        typeof parsed.messageID === "string"
      ) {
        map.set(`${parsed.sessionID}|${parsed.messageID}`, parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return map;
}

/** A restarted process cannot safely resume an in-memory manual approval gate. */
export function cancelOrphanedManualStates(): number {
  let cancelled = 0;
  for (const state of latestStatesPerMessage(statesFile()).values()) {
    if (state.protocolVersion !== 2 || !isActiveManualState(state)) continue;
    appendState({
      ...state,
      ts: Date.now(),
      phase: "cancelled",
      error: "approval_gate_restarted",
    });
    cancelled += 1;
  }
  return cancelled;
}

export function readSessionFlags(
  file: string,
  sessionID: string,
  defaults: PromptEditorSessionFlags = PROMPT_EDITOR_FLAG_DEFAULTS,
): PromptEditorSessionFlags {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A missing file means no preference has been stored. Corruption or an
    // unreadable existing file must not silently turn manual approval off.
    if (existsSync(file)) return { enabled: true, autoAccept: false };
    return defaults;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { enabled: true, autoAccept: false };
  const stored = Object.prototype.hasOwnProperty.call(parsed, sessionID)
    ? (parsed as Record<string, unknown>)[sessionID]
    : undefined;
  if (stored === undefined) return defaults;
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    return { enabled: true, autoAccept: false };
  const record = stored as Record<string, unknown>;
  const malformed =
    (Object.prototype.hasOwnProperty.call(record, "enabled") &&
      typeof record.enabled !== "boolean") ||
    (Object.prototype.hasOwnProperty.call(record, "autoAccept") &&
      typeof record.autoAccept !== "boolean");
  return {
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    autoAccept: malformed
      ? false
      : typeof record.autoAccept === "boolean"
        ? record.autoAccept
        : defaults.autoAccept,
  };
}

/** Read pending requests (oldest first), excluding ones already seen. */
export function readRequests(
  file: string,
  seen: Set<string>,
  markSeen = true,
): PromptEditorRequest[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: PromptEditorRequest[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PromptEditorRequest;
      if (
        !parsed ||
        parsed.protocolVersion !== 2 ||
        (parsed.kind !== "accept" &&
          parsed.kind !== "reject" &&
          parsed.kind !== "re-evaluate") ||
        typeof parsed.sessionID !== "string" ||
        typeof parsed.messageID !== "string" ||
        typeof parsed.gateID !== "string" ||
        parsed.gateID.length < 8 ||
        typeof parsed.ts !== "number" ||
        !Number.isSafeInteger(parsed.revision) ||
        parsed.revision < 1
      )
        continue;
      const id = promptEditorRequestIdentity(parsed);
      if (seen.has(id)) continue;
      if (markSeen) seen.add(id);
      out.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
