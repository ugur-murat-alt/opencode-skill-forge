import type { LocalConfig } from "../cli/config.js";
import type { ContextKnown } from "./context-state.js";

/**
 * Issue #38 (M05) Faz B: bounded reader for the M03 context compiler.
 *
 * The hook never compiles context itself and never calls a model; it asks the
 * authenticated local service for the already-sourced package. A timeout,
 * missing space, non-200 or unexpected shape all mean "no context" (fail-open,
 * never wrong/old tenant data).
 */

export interface MemoryContextCard {
  note_id: string;
  space_id: string;
  revision: number;
  kind: string;
  title: string;
  snippet: string;
  match_reason: string;
  pinned: boolean;
  token_estimate: number;
  lifecycle: string;
  task_status: string | null;
}

export interface MemoryContextPackage {
  envelope: {
    package_hash: string;
    generation: number | null;
    session_key: string | null;
    token_estimator: string;
    budget?: { max_tokens: number; used_tokens_estimate: number };
  };
  cards: MemoryContextCard[];
  sections: {
    active_tasks: string[];
    blockers: string[];
    recent_decisions: string[];
    pins: string[];
    continuation: string | null;
  };
  truncated: boolean;
  continuation_note: { note_id: string; revision: number } | null;
  offered: { note_id: string; revision: number; content_hash: string }[];
}

export type ContextFetchResult =
  | { status: "ok"; package: MemoryContextPackage }
  | { status: "empty" }
  | { status: "timeout" }
  | { status: "error"; code: string };

export interface ContextFetchInput {
  config: Pick<LocalConfig, "url" | "token">;
  spaceId: string;
  sessionKey: string;
  generation: number;
  branch: string | null;
  worktree: string | null;
  goal?: string;
  known: ContextKnown[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  /** Absolute timestamp shared by the space lookup and the context call. */
  deadline: number;
}

const MAX_KNOWN_ENTRIES = 40;
const MAX_KNOWN_CHARS = 7000;

export function serializeKnown(known: ContextKnown[]): string | null {
  const bounded = known
    .slice(0, MAX_KNOWN_ENTRIES)
    .filter(
      (entry) =>
        typeof entry.note_id === "string" &&
        entry.note_id.length <= 200 &&
        Number.isInteger(entry.revision),
    );
  if (bounded.length === 0) return null;
  let text = "";
  for (const entry of bounded) {
    const next = `${text ? "," : ""}${entry.note_id}:${entry.revision}`;
    if (next.length > MAX_KNOWN_CHARS) break;
    text = next;
  }
  return text || null;
}

export async function fetchMemoryContext(
  input: ContextFetchInput,
): Promise<ContextFetchResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const remaining = () => Math.max(1, input.deadline - Date.now());
  const query = new URLSearchParams({
    space_id: input.spaceId,
    session_key: input.sessionKey,
    generation: String(input.generation),
    max_tokens: String(input.maxTokens),
  });
  if (input.branch) query.set("branch", input.branch);
  if (input.worktree) query.set("worktree", input.worktree);
  if (input.goal) query.set("goal", input.goal.slice(0, 1000));
  const known = serializeKnown(input.known);
  if (known) query.set("known", known);
  let response: Response;
  try {
    response = await fetchImpl(
      `${input.config.url}/api/memory/context?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${input.config.token}` },
        signal: AbortSignal.timeout(Math.min(input.timeoutMs, remaining())),
      },
    );
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError")
      return { status: "timeout" };
    return { status: "error", code: "network_error" };
  }
  if (!response.ok) return { status: "error", code: `http_${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", code: "invalid_json" };
  }
  const parsed = parsePackage(body, input.spaceId);
  if (!parsed) return { status: "error", code: "unexpected_shape" };
  if (parsed.cards.length === 0) return { status: "empty" };
  return { status: "ok", package: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePackage(
  value: unknown,
  expectedSpaceId: string,
): MemoryContextPackage | null {
  if (!isRecord(value)) return null;
  const envelope = value.envelope;
  const cards = value.cards;
  const offered = value.offered;
  if (!isRecord(envelope) || !Array.isArray(cards) || !Array.isArray(offered))
    return null;
  if (typeof envelope.package_hash !== "string") return null;
  if (value.sections !== undefined && !isRecord(value.sections)) return null;
  const validated: MemoryContextCard[] = [];
  for (const card of cards) {
    if (!isRecord(card)) return null;
    if (
      typeof card.note_id !== "string" ||
      typeof card.space_id !== "string" ||
      typeof card.revision !== "number" ||
      typeof card.kind !== "string" ||
      typeof card.title !== "string" ||
      typeof card.snippet !== "string"
    )
      return null;
    // Defense in depth: never surface another space's card.
    if (card.space_id !== expectedSpaceId) continue;
    validated.push({
      note_id: card.note_id,
      space_id: card.space_id,
      revision: card.revision,
      kind: card.kind,
      title: card.title,
      snippet: card.snippet,
      match_reason:
        typeof card.match_reason === "string" ? card.match_reason : "",
      pinned: card.pinned === true,
      token_estimate:
        typeof card.token_estimate === "number" ? card.token_estimate : 0,
      lifecycle: typeof card.lifecycle === "string" ? card.lifecycle : "active",
      task_status:
        typeof card.task_status === "string" ? card.task_status : null,
    });
  }
  const offeredValidated = offered.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.note_id !== "string" ||
      typeof entry.revision !== "number"
    )
      return [];
    return [
      {
        note_id: entry.note_id,
        revision: entry.revision,
        content_hash:
          typeof entry.content_hash === "string" ? entry.content_hash : "",
      },
    ];
  });
  const sectionsValue = value.sections;
  const sections = isRecord(sectionsValue)
    ? {
        active_tasks: stringArray(sectionsValue.active_tasks),
        blockers: stringArray(sectionsValue.blockers),
        recent_decisions: stringArray(sectionsValue.recent_decisions),
        pins: stringArray(sectionsValue.pins),
        continuation:
          typeof sectionsValue.continuation === "string"
            ? sectionsValue.continuation
            : null,
      }
    : {
        active_tasks: [],
        blockers: [],
        recent_decisions: [],
        pins: [],
        continuation: null,
      };
  return {
    envelope: {
      package_hash: envelope.package_hash,
      generation:
        typeof envelope.generation === "number" ? envelope.generation : null,
      session_key:
        typeof envelope.session_key === "string" ? envelope.session_key : null,
      token_estimator:
        typeof envelope.token_estimator === "string"
          ? envelope.token_estimator
          : "unknown",
      budget: isRecord(envelope.budget)
        ? {
            max_tokens:
              typeof envelope.budget.max_tokens === "number"
                ? envelope.budget.max_tokens
                : 0,
            used_tokens_estimate:
              typeof envelope.budget.used_tokens_estimate === "number"
                ? envelope.budget.used_tokens_estimate
                : 0,
          }
        : undefined,
    },
    cards: validated,
    sections,
    truncated: value.truncated === true,
    continuation_note: isRecord(value.continuation_note)
      ? {
          note_id: String(value.continuation_note.note_id ?? ""),
          revision: Number(value.continuation_note.revision ?? 0),
        }
      : null,
    offered: offeredValidated,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 50)
    : [];
}
