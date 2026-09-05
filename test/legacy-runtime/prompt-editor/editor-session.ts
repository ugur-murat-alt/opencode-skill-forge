import type { PluginRuntime } from "./types.js";
import { EDITOR_AGENT_ID, EDITOR_SESSION_TITLE } from "./constants.js";
import { discover, headers } from "@opencode-ai/client/service";

export async function createEditorSession(
  ctx: PluginRuntime,
  input: {
    directory: string;
    model?: { providerID: string; id: string; variant?: string };
  },
  signal?: AbortSignal,
): Promise<{ id?: string | null }> {
  const inputModel = input.model
    ? {
        providerID: input.model.providerID,
        id: input.model.id,
        ...(input.model.variant ? { variant: input.model.variant } : {}),
      }
    : undefined;
  return ctx.session.create(
    {
      title: EDITOR_SESSION_TITLE,
      agent: EDITOR_AGENT_ID,
      location: { directory: input.directory },
      ...(inputModel ? { model: inputModel } : {}),
    },
    { signal },
  );
}

export function promptEditorSession(
  ctx: PluginRuntime,
  sessionID: string,
  text: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return ctx.session.prompt({ sessionID, text }, { signal });
}

export function waitForEditorSession(
  ctx: PluginRuntime,
  sessionID: string,
  signal?: AbortSignal,
): Promise<void> {
  return ctx.session.wait({ sessionID }, { signal });
}

export async function interruptEditor(
  ctx: PluginRuntime,
  sessionID: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.session.interrupt({ sessionID }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 4_000);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    // best-effort
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function storedMessageType(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record["type"] === "string") return record["type"] as string;
  const data = record["data"];
  if (!data || typeof data !== "object") return null;
  const type = (data as Record<string, unknown>)["type"];
  return typeof type === "string" ? type : null;
}

/** Resolve the durable OpenCode message kind; failures skip rewriting. */
export async function resolveStoredMessageType(
  sessionID: string,
  messageID: string,
  timeoutMs = 2_000,
): Promise<string | null> {
  let cancelDiscoveryTimeout = () => {};
  try {
    const endpoint = await Promise.race([
      discover(),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
        cancelDiscoveryTimeout = () => clearTimeout(timer);
      }),
    ]).finally(() => cancelDiscoveryTimeout());
    if (!endpoint) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        new URL(
          `/api/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`,
          endpoint.url,
        ),
        {
          headers: { accept: "application/json", ...headers(endpoint) },
          signal: controller.signal,
        },
      );
      if (!response.ok) return null;
      return storedMessageType(await response.json());
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Delete the transient editor session through the server API. */
export async function deleteEditorSession(sessionID: string): Promise<void> {
  let cancelDiscoveryTimeout = () => {};
  const endpoint = await Promise.race([
    discover(),
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, 4_000);
      (timer as unknown as { unref?: () => void }).unref?.();
      cancelDiscoveryTimeout = () => clearTimeout(timer);
    }),
  ]).finally(() => cancelDiscoveryTimeout());
  if (!endpoint) throw new Error("OpenCode service unavailable");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(
      new URL(`/api/session/${encodeURIComponent(sessionID)}`, endpoint.url),
      {
        method: "DELETE",
        headers: headers(endpoint),
        signal: controller.signal,
      },
    );
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`HTTP ${response.status} while deleting editor session`);
    }
  } finally {
    clearTimeout(timer);
  }
}
