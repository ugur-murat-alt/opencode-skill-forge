import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { editorSystemForConfig } from "./system.js";
import { safeEditorTools, type PromptEditorConfig } from "./config.js";
import { EDITOR_AGENT_ID, SUBMIT_TOOL_NAME } from "./constants.js";
import type { PluginRuntime } from "./types.js";

export interface EditorAgentConfig {
  model: string | null;
  variant: string | null;
  description: string;
}

type AgentPermission = {
  action: string;
  resource: string;
  effect: "allow" | "deny";
};

export const EDITOR_AGENT_DEFAULTS: EditorAgentConfig = {
  model: null,
  variant: null,
  description:
    "Internal prompt rewriter (prompt engineering before the main agent).",
};

/** Best-effort JSONC parser (comment/trailing-comma tolerant). */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Strip both full-line and trailing (end-of-line) comments.
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(stripped);
}

/**
 * Loads the packaged prompt-editor-agent.jsonc (next to the plugin bundle) if
 * present; otherwise falls back to the embedded defaults. Overrides via the
 * options block take precedence over this file.
 */
export function loadEditorAgentConfig(
  importMetaUrl: string,
): EditorAgentConfig {
  let fileConfig: Partial<EditorAgentConfig> | undefined;
  try {
    const url = new URL("./prompt-editor-agent.jsonc", importMetaUrl);
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      const parsed = parseJsonc(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      fileConfig = sanitizeAgentConfig(parsed);
    }
  } catch (error) {
    console.warn(
      `[prompt-editor] could not load prompt-editor-agent.jsonc: ${String(error)}`,
    );
  }
  return { ...EDITOR_AGENT_DEFAULTS, ...fileConfig };
}

function sanitizeAgentConfig(
  raw: Record<string, unknown>,
): Partial<EditorAgentConfig> {
  const out: Partial<EditorAgentConfig> = {};
  if (typeof raw["model"] === "string" && raw["model"])
    out.model = raw["model"] as string;
  if (typeof raw["variant"] === "string" && raw["variant"])
    out.variant = raw["variant"] as string;
  if (typeof raw["description"] === "string")
    out.description = raw["description"] as string;
  return out;
}

/** "provider/model" + optional variant → { providerID, id, variant }. */
export function resolveAgentModel(
  cfg: PromptEditorConfig,
  agentCfg: EditorAgentConfig,
): { providerID: string; id: string; variant?: string } | undefined {
  const model = cfg.model ?? agentCfg.model;
  const variant = cfg.variant ?? agentCfg.variant;
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `invalid prompt-editor model "${model}": expected provider/model`,
    );
  }
  return {
    providerID: model.slice(0, slash),
    id: model.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

/** Deny-first permissions derived from the config allowlist. */
export function agentPermissions(cfg: PromptEditorConfig): AgentPermission[] {
  const allowed = safeEditorTools(cfg.tools);
  const perms: AgentPermission[] = [
    { action: "*", resource: "*", effect: "deny" },
  ];
  for (const tool of allowed)
    perms.push({ action: tool, resource: "*", effect: "allow" });
  if (!allowed.some((t) => t === SUBMIT_TOOL_NAME)) {
    perms.push({ action: SUBMIT_TOOL_NAME, resource: "*", effect: "allow" });
  }
  return perms;
}

/**
 * Registers (or updates) the hidden omni-prompt-editor agent. Mirrors the
 * skill-forge spr-agent registration pattern (draft.update).
 */
export async function registerEditorAgent(
  ctx: PluginRuntime,
  cfg: PromptEditorConfig,
  agentCfg: EditorAgentConfig,
): Promise<unknown> {
  const model = resolveAgentModel(cfg, agentCfg);
  const permissions = agentPermissions(cfg);
  const system = editorSystemForConfig(cfg);
  return ctx.agent.transform((draft) => {
    draft.update(EDITOR_AGENT_ID, (agent) => {
      agent.description = cfg.description ?? agentCfg.description;
      agent.system = system;
      agent.mode = "subagent";
      agent.hidden = true;
      agent.steps = cfg.maxSteps;
      if (model) agent.model = model;
      else delete agent.model;
      agent.permissions = [...permissions];
    });
  });
}
