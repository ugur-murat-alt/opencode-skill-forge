import { sanitizePromptEditorText } from "./context-snapshot.js";

const MAX_TOOL_NAME_CHARS = 160;
const MAX_TOOL_DESCRIPTION_CHARS = 180;
const MAX_INCLUDED_TOOLS = 256;

export interface PromptEditorToolCapability {
  name: string;
  description: string;
}

export interface PromptEditorCapabilityCatalog {
  /** MCP or plugin provider prefixes inferred from namespaced runtime tools. */
  providers: readonly string[];
  /** Effective tools exposed to the main agent for this exact request. */
  tools: readonly PromptEditorToolCapability[];
  totalTools: number;
  omittedTools: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function oneLine(value: string, maxChars: number): string {
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  }).join("");
  const normalized = withoutControls.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function toolDescription(value: unknown): string {
  try {
    if (value && typeof value === "object") {
      const description = (value as { description?: unknown }).description;
      if (typeof description === "string") {
        const normalized = oneLine(
          sanitizePromptEditorText(description, MAX_TOOL_DESCRIPTION_CHARS),
          MAX_TOOL_DESCRIPTION_CHARS,
        );
        if (normalized) return normalized;
      }
    }
  } catch {
    // Tool definitions come from the runtime and may be unusual objects.
  }
  return "Runtime did not provide a description.";
}

function providerFromToolName(name: string): string | null {
  const separator = name.indexOf("_");
  if (separator <= 0) return null;
  const provider = name.slice(0, separator);
  return provider ? oneLine(provider, MAX_TOOL_NAME_CHARS) : null;
}

/**
 * Capture the effective main-agent tool catalog from the context hook. This is
 * more accurate than configured MCP state because agent permissions and plugin
 * transforms have already been applied to `event.tools`.
 */
export function collectRuntimeCapabilities(
  tools: Record<string, unknown>,
): PromptEditorCapabilityCatalog {
  let names: string[];
  try {
    names = Object.keys(tools).sort(compareText);
  } catch {
    names = [];
  }

  const includedNames = names.slice(0, MAX_INCLUDED_TOOLS);
  const capabilities = includedNames.map((rawName) => {
    const name = oneLine(rawName, MAX_TOOL_NAME_CHARS) || "(unnamed tool)";
    let definition: unknown;
    try {
      definition = tools[rawName];
    } catch {
      definition = undefined;
    }
    return Object.freeze({
      name,
      description: toolDescription(definition),
    });
  });
  const providers = [
    ...new Set(
      includedNames
        .map(providerFromToolName)
        .filter((provider): provider is string => provider !== null),
    ),
  ].sort(compareText);

  return Object.freeze({
    providers: Object.freeze(providers),
    tools: Object.freeze(capabilities),
    totalTools: names.length,
    omittedTools: Math.max(0, names.length - capabilities.length),
  });
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

/** Render a compact, readable block for the hidden editor agent. */
export function renderRuntimeCapabilities(
  catalog: PromptEditorCapabilityCatalog,
): string[] {
  const providers =
    catalog.providers.length > 0
      ? catalog.providers.map(inlineCode).join(", ")
      : "(none detected)";
  const toolCount =
    catalog.omittedTools > 0
      ? `${catalog.tools.length} shown of ${catalog.totalTools}`
      : String(catalog.totalTools);
  const lines = [
    "MAIN AGENT EXECUTION CAPABILITIES (runtime-effective, untrusted reference data):",
    "This describes the main agent after OpenCode permissions, plugins, and MCP tool exposure. It is not your editor tool set.",
    `Visible namespaced MCP/plugin providers (inferred from tool names): ${providers}`,
    `Available tools (${toolCount}):`,
  ];
  if (catalog.tools.length === 0) {
    lines.push("- (no tools exposed to the main agent)");
  } else {
    for (const tool of catalog.tools)
      lines.push(
        `- ${inlineCode(tool.name)} — ${JSON.stringify(tool.description)}`,
      );
  }
  if (catalog.omittedTools > 0)
    lines.push(
      `- (${catalog.omittedTools} additional tools omitted by the safety cap)`,
    );
  return lines;
}
