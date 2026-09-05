export interface PromptEditorConfig {
  enabled: boolean;
  /** "provider/model" or null to use the package default (prompt-editor-agent.jsonc). */
  model: string | null;
  variant: string | null;
  /** Optional agent description override. */
  description: string | null;
  /** Hard cap on editor agent steps (agent config `steps`). */
  maxSteps: number;
  /** Editor run deadline. Always finite so the context hook stays fail-open. */
  timeoutMs: number;
  /** Deadline for resolving the owning session directory. */
  directoryTimeoutMs: number;
  /** Maximum time spent deleting the transient editor session. */
  cleanupTimeoutMs: number;
  /**
   * When true the context hook waits for the editor run (real-time rewrite,
   * bounded by `timeoutMs` when it is positive). When false the hook
   * returns immediately (fail-open), the editor runs in the background, and
   * the improved prompt is recorded for display (rewrites.jsonl / learn.md /
   * journal) — never freezing the conversation.
   */
  blocking: boolean;
  /** Default editor enabled state for sessions without a stored runtime flag. */
  defaultSessionEnabled: boolean;
  /** Default approval mode for sessions without a stored runtime flag. */
  defaultAutoAccept: boolean;
  /** Messages shorter than this are never rewritten (fail-open). */
  minChars: number;
  /**
   * Messages longer than this are never rewritten, preventing oversized
   * editor requests even when the run deadline is disabled.
   */
  maxChars: number;
  /** Whether an accepted submission must differ from the original message. */
  rewriteMode: "always" | "when-needed";
  /** Controls how much context-backed detail the editor adds. */
  detailLevel: "concise" | "balanced" | "thorough";
  /** Correct spelling, grammar, punctuation, and wording. */
  correctWriting: boolean;
  /** Controls whether the editor submits a durable lesson. */
  learningMode: "always" | "reusable-only" | "off";
  /** Number of previous user messages included in the editor context. */
  contextUserMessages: number;
  /** Number of previous assistant messages included in the editor context. */
  contextAssistantMessages: number;
  /** Number of previous tool calls included in the editor context. */
  contextToolCalls: number;
  /** Per-message text cap for previous user messages. */
  contextUserMessageChars: number;
  /** Per-message text cap for previous assistant messages. */
  contextAssistantMessageChars: number;
  /** Per-call serialized cap for tool input and output. */
  contextToolCallChars: number;
  /** Aggregate serialized cap for the context snapshot. */
  contextMaxChars: number;
  /** Maximum prior messages inspected while collecting context. */
  contextScanMessages: number;
  /** Maximum content parts inspected per message. */
  contextPartsPerMessage: number;
  /** Aggregate source-text budget inspected while collecting context. */
  contextInputChars: number;
  /** Include sanitized tool inputs in context. */
  contextIncludeToolInputs: boolean;
  /** Include sanitized tool outputs in context. */
  contextIncludeToolOutputs: boolean;
  /** Explicit override for the global learn.md path. */
  learnFile: string | null;
  /** Per-entry character cap for learn.md. */
  learnEntryMaxChars: number;
  /** Size cap for learn.md (bytes). Older entries are trimmed once exceeded. */
  learnMaxBytes: number;
  /** Character cap for learn.md content injected into one editor run. */
  learnContextMaxChars: number;
  /** Read-only tools exposed to the editor agent (allowlist). */
  tools: string[];
  /** Persist the rewrite to the stored message so UIs reflect it. */
  persist: boolean;
}

export const PROMPT_EDITOR_DEFAULTS: PromptEditorConfig = {
  enabled: false,
  model: null,
  variant: null,
  description: null,
  maxSteps: 30,
  timeoutMs: 30_000,
  directoryTimeoutMs: 5_000,
  cleanupTimeoutMs: 4_000,
  blocking: true,
  defaultSessionEnabled: true,
  defaultAutoAccept: true,
  minChars: 1,
  maxChars: 200_000,
  rewriteMode: "always",
  detailLevel: "thorough",
  correctWriting: true,
  learningMode: "always",
  contextUserMessages: 3,
  contextAssistantMessages: 3,
  contextToolCalls: 10,
  contextUserMessageChars: 5_000,
  contextAssistantMessageChars: 5_000,
  contextToolCallChars: 3_000,
  contextMaxChars: 96 * 1024,
  contextScanMessages: 512,
  contextPartsPerMessage: 128,
  contextInputChars: 256 * 1024,
  contextIncludeToolInputs: true,
  contextIncludeToolOutputs: true,
  learnFile: null,
  learnEntryMaxChars: 5_000,
  learnMaxBytes: 256 * 1024,
  learnContextMaxChars: 64 * 1024,
  tools: ["read", "grep", "glob"],
  persist: true,
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"]);

function asInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  return Math.min(max, Math.max(min, n));
}

function asEnum<T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly T[],
): T {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

function asTimeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return fallback;
  return Math.min(120_000, Math.max(1_000, Math.trunc(value)));
}

/**
 * Resolves the `promptEditor` options block. Independent of the master
 * `enabled` flag: the editor subsystem can run even when the skill-forge
 * subsystem is disabled.
 */
export function resolvePromptEditorOptions(
  options: Record<string, unknown> | undefined,
): PromptEditorConfig {
  const raw =
    options && typeof options === "object" && "promptEditor" in options
      ? (options["promptEditor"] as Record<string, unknown> | undefined)
      : undefined;
  if (!raw || typeof raw !== "object") {
    return { ...PROMPT_EDITOR_DEFAULTS };
  }

  const cfg: PromptEditorConfig = {
    ...PROMPT_EDITOR_DEFAULTS,
    enabled: raw["enabled"] === true,
  };

  if (typeof raw["model"] === "string" && raw["model"])
    cfg.model = raw["model"] as string;
  if (typeof raw["variant"] === "string" && raw["variant"])
    cfg.variant = raw["variant"] as string;
  if (typeof raw["description"] === "string" && raw["description"].trim())
    cfg.description = (raw["description"] as string).trim();
  cfg.maxSteps = asInt(
    raw["maxSteps"],
    PROMPT_EDITOR_DEFAULTS.maxSteps,
    1,
    100,
  );
  cfg.timeoutMs = asTimeout(raw["timeoutMs"], PROMPT_EDITOR_DEFAULTS.timeoutMs);
  cfg.directoryTimeoutMs = asInt(
    raw["directoryTimeoutMs"],
    PROMPT_EDITOR_DEFAULTS.directoryTimeoutMs,
    100,
    60_000,
  );
  cfg.cleanupTimeoutMs = asInt(
    raw["cleanupTimeoutMs"],
    PROMPT_EDITOR_DEFAULTS.cleanupTimeoutMs,
    100,
    60_000,
  );
  cfg.minChars = asInt(
    raw["minChars"],
    PROMPT_EDITOR_DEFAULTS.minChars,
    0,
    10_000,
  );
  cfg.maxChars = asInt(
    raw["maxChars"],
    PROMPT_EDITOR_DEFAULTS.maxChars,
    1_000,
    200_000,
  );
  cfg.rewriteMode = asEnum(
    raw["rewriteMode"],
    PROMPT_EDITOR_DEFAULTS.rewriteMode,
    ["always", "when-needed"],
  );
  cfg.detailLevel = asEnum(
    raw["detailLevel"],
    PROMPT_EDITOR_DEFAULTS.detailLevel,
    ["concise", "balanced", "thorough"],
  );
  if (typeof raw["correctWriting"] === "boolean")
    cfg.correctWriting = raw["correctWriting"] as boolean;
  cfg.learningMode = asEnum(
    raw["learningMode"],
    PROMPT_EDITOR_DEFAULTS.learningMode,
    ["always", "reusable-only", "off"],
  );
  cfg.contextUserMessages = asInt(
    raw["contextUserMessages"],
    PROMPT_EDITOR_DEFAULTS.contextUserMessages,
    0,
    20,
  );
  cfg.contextAssistantMessages = asInt(
    raw["contextAssistantMessages"],
    PROMPT_EDITOR_DEFAULTS.contextAssistantMessages,
    0,
    20,
  );
  cfg.contextToolCalls = asInt(
    raw["contextToolCalls"],
    PROMPT_EDITOR_DEFAULTS.contextToolCalls,
    0,
    100,
  );
  cfg.contextUserMessageChars = asInt(
    raw["contextUserMessageChars"],
    PROMPT_EDITOR_DEFAULTS.contextUserMessageChars,
    128,
    50_000,
  );
  cfg.contextAssistantMessageChars = asInt(
    raw["contextAssistantMessageChars"],
    PROMPT_EDITOR_DEFAULTS.contextAssistantMessageChars,
    128,
    50_000,
  );
  cfg.contextToolCallChars = asInt(
    raw["contextToolCallChars"],
    PROMPT_EDITOR_DEFAULTS.contextToolCallChars,
    128,
    20_000,
  );
  cfg.contextMaxChars = asInt(
    raw["contextMaxChars"],
    PROMPT_EDITOR_DEFAULTS.contextMaxChars,
    1_024,
    1_000_000,
  );
  cfg.contextScanMessages = asInt(
    raw["contextScanMessages"],
    PROMPT_EDITOR_DEFAULTS.contextScanMessages,
    1,
    5_000,
  );
  cfg.contextPartsPerMessage = asInt(
    raw["contextPartsPerMessage"],
    PROMPT_EDITOR_DEFAULTS.contextPartsPerMessage,
    1,
    1_024,
  );
  cfg.contextInputChars = asInt(
    raw["contextInputChars"],
    PROMPT_EDITOR_DEFAULTS.contextInputChars,
    1_024,
    2_000_000,
  );
  if (typeof raw["contextIncludeToolInputs"] === "boolean")
    cfg.contextIncludeToolInputs = raw["contextIncludeToolInputs"] as boolean;
  if (typeof raw["contextIncludeToolOutputs"] === "boolean")
    cfg.contextIncludeToolOutputs = raw["contextIncludeToolOutputs"] as boolean;
  cfg.learnEntryMaxChars = asInt(
    raw["learnEntryMaxChars"],
    PROMPT_EDITOR_DEFAULTS.learnEntryMaxChars,
    1,
    50_000,
  );
  cfg.learnMaxBytes = asInt(
    raw["learnMaxBytes"],
    PROMPT_EDITOR_DEFAULTS.learnMaxBytes,
    1_024,
    10_000_000,
  );
  cfg.learnContextMaxChars = asInt(
    raw["learnContextMaxChars"],
    PROMPT_EDITOR_DEFAULTS.learnContextMaxChars,
    0,
    1_000_000,
  );
  if (typeof raw["learnFile"] === "string" && raw["learnFile"])
    cfg.learnFile = raw["learnFile"] as string;
  if (Array.isArray(raw["tools"])) {
    const candidate = raw["tools"] as unknown[];
    const allStrings = candidate.every((t) => typeof t === "string");
    cfg.tools = allStrings
      ? safeEditorTools(candidate as string[])
      : PROMPT_EDITOR_DEFAULTS.tools;
  }
  if (typeof raw["persist"] === "boolean")
    cfg.persist = raw["persist"] as boolean;
  if (typeof raw["blocking"] === "boolean")
    cfg.blocking = raw["blocking"] as boolean;
  if (typeof raw["defaultSessionEnabled"] === "boolean")
    cfg.defaultSessionEnabled = raw["defaultSessionEnabled"] as boolean;
  if (typeof raw["defaultAutoAccept"] === "boolean")
    cfg.defaultAutoAccept = raw["defaultAutoAccept"] as boolean;

  // NUL expands to six JSON code units (\u0000), covering the worst escaping
  // case for every 32-code-unit field retained by boundedSnapshot.
  const minimumText = "\u0000".repeat(32);
  const structuralContextMinimum = JSON.stringify({
    directory: minimumText,
    userMessages: Array.from(
      { length: cfg.contextUserMessages },
      () => minimumText,
    ),
    assistantMessages: Array.from(
      { length: cfg.contextAssistantMessages },
      () => minimumText,
    ),
    toolCalls: Array.from({ length: cfg.contextToolCalls }, () => ({
      name: minimumText,
      status: minimumText,
      input: minimumText,
      output: { kind: "content", text: minimumText },
    })),
  }).length;
  cfg.contextMaxChars = Math.max(cfg.contextMaxChars, structuralContextMinimum);

  return cfg;
}

/**
 * Read-only tool allowlist for the editor agent. Guards against accidentally
 * granting a write-capable tool through the raw config.
 */
export function safeEditorTools(tools: string[]): string[] {
  return [
    ...new Set(
      tools
        .map((tool) => tool.toLowerCase())
        .filter((tool) => READ_ONLY_TOOLS.has(tool)),
    ),
  ];
}
