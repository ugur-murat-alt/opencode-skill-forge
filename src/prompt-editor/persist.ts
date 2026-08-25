import { discover, headers } from "@opencode-ai/client/service";

export type PersistOutcome = "updated" | "unsupported" | "failed";

export interface PersistOptions {
  sessionID: string;
  messageID: string;
  originalText: string;
  newText: string;
  signal?: AbortSignal;
}

interface AuthHeaders {
  authorization?: string;
}

interface Endpoint {
  url: string;
  auth?: { type: "basic"; username: string; password: string };
}

async function requestJson(
  baseUrl: string,
  path: string,
  method: "GET" | "PATCH",
  auth: AuthHeaders,
  body?: unknown,
  timeoutMs = 4_000,
  signal?: AbortSignal,
): Promise<unknown> {
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (signal?.aborted) ac.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...auth,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${method} ${path}`);
    if (res.status === 204) return undefined;
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Whether the running server exposes durable message parts at all (needed for
 * `part.update`). Cached after the first probe so we fail fast afterwards.
 *
 * The API shape differs by server version:
 *  - Some servers return messages with `parts[]` carrying durable `id`/`type`.
 *  - The current one (beta-17639) returns aggregated messages with no part
 *    ids and exposes no `PATCH .../message/{m}/part/{p}` route → unsupported.
 */
const capability = { checked: false, supported: false };

function hasDurablePartIds(payload: unknown): boolean {
  let messages: unknown[] = [];
  if (Array.isArray(payload)) messages = payload;
  else if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec["data"])) messages = rec["data"] as unknown[];
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const rec = msg as Record<string, unknown>;
    const parts = Array.isArray(rec["parts"])
      ? (rec["parts"] as unknown[])
      : [];
    if (
      parts.some(
        (p) =>
          p &&
          typeof p === "object" &&
          typeof (p as Record<string, unknown>)["id"] === "string",
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Locate the text part to rewrite inside a server messages payload. */
export function findTextPart(
  payload: unknown,
  messageID: string,
  originalText: string,
): { part: Record<string, unknown> } | null {
  let messages: unknown[] = [];
  if (Array.isArray(payload)) messages = payload;
  else if (payload && typeof payload === "object") {
    const asRecord = payload as Record<string, unknown>;
    if (Array.isArray(asRecord["data"]))
      messages = asRecord["data"] as unknown[];
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const rec = msg as Record<string, unknown>;
    const info = (rec["info"] ?? rec["message"] ?? rec) as
      Record<string, unknown> | undefined;
    const id = typeof info?.id === "string" ? info.id : undefined;
    if (id !== messageID) continue;
    const partsRaw = Array.isArray(rec["parts"])
      ? (rec["parts"] as unknown[])
      : [];
    for (const p of partsRaw) {
      if (!p || typeof p !== "object") continue;
      const part = p as Record<string, unknown>;
      if (part["type"] !== "text") continue;
      const text =
        typeof part["text"] === "string" ? (part["text"] as string) : "";
      if (text && text === originalText) return { part };
    }
  }
  return null;
}

/**
 * Persist a rewritten user message at the server level (`part.update`, emitting
 * `PartUpdated` so streaming UIs reflect it). Requires a server build with
 * durable message parts + the part PATCH route. On servers without it this
 * returns "unsupported" (fail fast); on any other error → "failed". The caller
 * always keeps the request-scoped rewrite, so persistence is strictly additive.
 */
export async function persistRewrite(
  opts: PersistOptions,
): Promise<PersistOutcome> {
  if (opts.signal?.aborted) return "failed";
  if (capability.checked && !capability.supported) return "unsupported";

  let ep: Endpoint | undefined;
  let base = "";
  let auth: AuthHeaders = {};
  try {
    ep = (await discover()) as Endpoint | undefined;
    if (opts.signal?.aborted) return "failed";
    if (!ep) return "failed";
    base = ep.url.replace(/\/$/, "");
    auth = (headers(ep) ?? {}) as AuthHeaders;
  } catch {
    return "failed";
  }

  // 1. Probe the messages surface for durable part ids.
  try {
    const path = `/api/session/${opts.sessionID}/message`;
    const payload = await requestJson(
      base,
      path,
      "GET",
      auth,
      undefined,
      4_000,
      opts.signal,
    );
    if (!hasDurablePartIds(payload)) {
      capability.checked = true;
      capability.supported = false;
      return "unsupported";
    }
    capability.checked = true;
    capability.supported = true;
  } catch (error) {
    // Server may use an unprefixed route; treat a hard failure as unsupported.
    console.warn(
      `[prompt-editor] persist: message probe failed: ${String(error)}`,
    );
    return "failed";
  }

  // 2. Locate the text part (durable partID is server-internal).
  let part: Record<string, unknown> | null = null;
  try {
    const payload = await requestJson(
      base,
      `/api/session/${opts.sessionID}/message`,
      "GET",
      auth,
      undefined,
      4_000,
      opts.signal,
    );
    part =
      findTextPart(payload, opts.messageID, opts.originalText)?.part ?? null;
  } catch {
    part = null;
  }
  if (!part) return "failed";
  const partID = typeof part["id"] === "string" ? part["id"] : undefined;
  if (!partID) return "failed";

  // 3. PATCH the part with the rewritten text.
  const path = `/api/session/${opts.sessionID}/message/${opts.messageID}/part/${partID}`;
  try {
    await requestJson(
      base,
      path,
      "PATCH",
      auth,
      { ...part, text: opts.newText },
      4_000,
      opts.signal,
    );
    return "updated";
  } catch (error) {
    console.warn(`[prompt-editor] persist: PATCH failed: ${String(error)}`);
    return "failed";
  }
}
