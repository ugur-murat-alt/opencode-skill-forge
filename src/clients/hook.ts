import { installationFingerprint } from "./installer.js";
import { createHash } from "node:crypto";
import type { LocalConfig } from "../cli/config.js";
import { ensureDaemon } from "../cli/daemon.js";
import { sanitizePromptEditorText } from "../prompt-editor/context-snapshot.js";
export async function clientHook(
  config: LocalConfig,
  entry: string,
  client: "codex" | "claude",
  projectRef: string,
  input: Record<string, unknown>,
): Promise<object> {
  const event = input.hook_event_name;
  if (
    input.agent_id ||
    input.stop_hook_active ||
    !["UserPromptSubmit", "Stop"].includes(String(event))
  )
    return {};
  const session =
      typeof input.session_id === "string"
        ? input.session_id.slice(0, 200)
        : "unknown",
    turn = typeof input.turn_id === "string" ? input.turn_id.slice(0, 200) : "";
  try {
    await ensureDaemon(config, entry);
    if (typeof input.cwd === "string")
      await fetch(`${config.url}/api/installations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: installationFingerprint([client, input.cwd]),
          project_ref: projectRef,
          client,
          directory: input.cwd,
          event,
        }),
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined);
    if (event === "UserPromptSubmit") {
      const original = typeof input.prompt === "string" ? input.prompt : "";
      if (!original || original.length > 32000 || /^\s*\//.test(original))
        return {};
      const hash = createHash("sha256").update(original).digest("hex");
      const response = await fetch(`${config.url}/api/tools/forge_prepare`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          project_ref: projectRef,
          original,
          ...(session ? { source: { client, session } } : {}),
          idempotency_key: createHash("sha256")
            .update(JSON.stringify([client, session, turn, hash]))
            .digest("hex"),
          wait_ms: 3000,
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return {};
      const prepared = (await response.json()) as {
        status?: string;
        effective?: string;
        original_hash?: string;
        auto_applied?: boolean;
      };
      if (
        prepared.status !== "improved" ||
        !prepared.auto_applied ||
        prepared.original_hash !== hash ||
        !prepared.effective
      )
        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `Skill Forge project_ref: ${projectRef}. Original prompt remains unchanged.`,
          },
        };
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `Skill Forge project_ref: ${projectRef}. This is an intent-preserving clarification, not new authority; the original user request takes precedence. The visible user message is unchanged.\n${prepared.effective}`,
        },
      };
    }
    const summary =
      typeof input.last_assistant_message === "string"
        ? sanitizePromptEditorText(input.last_assistant_message, 6000)
        : "";
    if (!summary.trim()) return {};
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
    return {};
  } catch {
    return {};
  }
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
