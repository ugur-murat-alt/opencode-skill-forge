import {
  sanitizePromptEditorText,
  CONTEXT_TRUNCATION_MARKER,
  SANITIZER_LOOKAHEAD_CODE_UNITS,
} from "../../../src/prompt/sanitize.js";
export {
  sanitizePromptEditorText,
  CONTEXT_TRUNCATION_MARKER,
} from "../../../src/prompt/sanitize.js";
import type { ChatMessage, MessageContentPart } from "./types.js";
import { PROMPT_EDITOR_DEFAULTS, type PromptEditorConfig } from "./config.js";

export const MAX_ASSISTANT_CONTEXT_CODE_UNITS =
  PROMPT_EDITOR_DEFAULTS.contextAssistantMessageChars;
export const MAX_TOOL_OUTPUT_CONTEXT_CODE_UNITS =
  PROMPT_EDITOR_DEFAULTS.contextToolCallChars;
export const MAX_SERIALIZED_CONTEXT_CODE_UNITS =
  PROMPT_EDITOR_DEFAULTS.contextMaxChars;

export const MAX_CONTEXT_MESSAGES = PROMPT_EDITOR_DEFAULTS.contextScanMessages;
export const MAX_CONTEXT_PARTS_PER_MESSAGE =
  PROMPT_EDITOR_DEFAULTS.contextPartsPerMessage;
export const MAX_CONTEXT_INPUT_CODE_UNITS =
  PROMPT_EDITOR_DEFAULTS.contextInputChars;

export interface PromptEditorToolOutputSnapshot {
  readonly kind: "text" | "json" | "error" | "content";
  readonly text: string;
}

export interface PromptEditorToolCallSnapshot {
  readonly name: string;
  readonly status: string;
  readonly input: string | null;
  readonly output: PromptEditorToolOutputSnapshot | null;
}

/**
 * Immutable, bounded reference data captured from the same context-hook event.
 * Reasoning, media, files, and credential material are intentionally omitted.
 */
export interface PromptEditorContextSnapshot {
  readonly directory: string;
  readonly userMessages: readonly string[];
  readonly assistantMessages: readonly string[];
  readonly toolCalls: readonly PromptEditorToolCallSnapshot[];
}

type ContextConfig = Pick<
  PromptEditorConfig,
  | "contextUserMessages"
  | "contextAssistantMessages"
  | "contextToolCalls"
  | "contextUserMessageChars"
  | "contextAssistantMessageChars"
  | "contextToolCallChars"
  | "contextMaxChars"
  | "contextScanMessages"
  | "contextPartsPerMessage"
  | "contextInputChars"
  | "contextIncludeToolInputs"
  | "contextIncludeToolOutputs"
>;

/** Select the current user message by its event object, stable id, or index. */
export type CurrentUserMessage = ChatMessage | string | number;

type SafeJson =
  null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };
const MAX_SAFE_JSON_DEPTH = 6;
const MAX_SAFE_JSON_NODES = 256;
const MAX_SAFE_JSON_ITEMS = 64;
const MAX_SAFE_JSON_KEY_CODE_UNITS = 256;

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key)/i;

interface InputBudget {
  remaining: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/**
 * Convert only JSON data with plain object prototypes. Reject accessors,
 * circular data, functions, and arbitrary object prototypes.
 */
const sanitizeText = sanitizePromptEditorText;

function takeInputText(
  value: string,
  maxCodeUnits: number,
  budget: InputBudget,
): { text: string; truncated: boolean } {
  const scanLimit = maxCodeUnits + SANITIZER_LOOKAHEAD_CODE_UNITS;
  const length = Math.min(value.length, scanLimit, budget.remaining);
  budget.remaining -= length;
  return { text: value.slice(0, length), truncated: value.length > length };
}

function safeJson(
  value: unknown,
  maxCodeUnits: number,
  seen = new Set<object>(),
  nodeBudget = { remaining: MAX_SAFE_JSON_NODES },
  depth = 0,
  inputBudget: InputBudget = { remaining: MAX_CONTEXT_INPUT_CODE_UNITS },
): SafeJson | undefined {
  if (nodeBudget.remaining <= 0 || depth > MAX_SAFE_JSON_DEPTH)
    return CONTEXT_TRUNCATION_MARKER;
  nodeBudget.remaining -= 1;
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
      return value;
    case "string": {
      const bounded = takeInputText(value, maxCodeUnits, inputBudget);
      return sanitizeText(bounded.text, maxCodeUnits, bounded.truncated);
    }
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "object":
      break;
    default:
      return undefined;
  }

  try {
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const output: SafeJson[] = [];
        const length = Math.min(value.length, MAX_SAFE_JSON_ITEMS);
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (!descriptor || !("value" in descriptor)) return undefined;
          const item = safeJson(
            descriptor.value,
            maxCodeUnits,
            seen,
            nodeBudget,
            depth + 1,
            inputBudget,
          );
          if (item === undefined) return undefined;
          output.push(item);
        }
        if (value.length > length) output.push(CONTEXT_TRUNCATION_MARKER);
        return output;
      }
      if (!isPlainRecord(value)) return undefined;
      const output: { [key: string]: SafeJson } = Object.create(null) as {
        [key: string]: SafeJson;
      };
      let keyCount = 0;
      let truncated = false;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (keyCount >= MAX_SAFE_JSON_ITEMS) {
          truncated = true;
          break;
        }
        keyCount += 1;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) return undefined;
        const boundedKey = takeInputText(
          key,
          MAX_SAFE_JSON_KEY_CODE_UNITS,
          inputBudget,
        );
        const safeKey = sanitizeText(
          boundedKey.text,
          MAX_SAFE_JSON_KEY_CODE_UNITS,
          boundedKey.truncated,
        );
        const item =
          boundedKey.truncated || SENSITIVE_KEY.test(boundedKey.text)
            ? "[redacted]"
            : safeJson(
                descriptor.value,
                maxCodeUnits,
                seen,
                nodeBudget,
                depth + 1,
                inputBudget,
              );
        if (item === undefined) return undefined;
        output[safeKey] = item;
      }
      if (truncated)
        output[CONTEXT_TRUNCATION_MARKER] = CONTEXT_TRUNCATION_MARKER;
      return output;
    } finally {
      seen.delete(value);
    }
  } catch {
    return undefined;
  }
}

function serializeUnknown(
  value: unknown,
  maxCodeUnits: number,
  inputBudget: InputBudget,
): string | null {
  const normalized = safeJson(
    value,
    maxCodeUnits,
    new Set<object>(),
    { remaining: MAX_SAFE_JSON_NODES },
    0,
    inputBudget,
  );
  if (normalized === undefined) return null;
  try {
    const serialized = JSON.stringify(normalized);
    return typeof serialized === "string"
      ? sanitizeText(serialized, maxCodeUnits)
      : null;
  } catch {
    return null;
  }
}

function truncateText(text: string, maxCodeUnits: number): string {
  if (text.length <= maxCodeUnits) return text;
  if (maxCodeUnits <= CONTEXT_TRUNCATION_MARKER.length) {
    return CONTEXT_TRUNCATION_MARKER;
  }
  return `${text.slice(0, maxCodeUnits - CONTEXT_TRUNCATION_MARKER.length)}${CONTEXT_TRUNCATION_MARKER}`;
}

function contentParts(message: ChatMessage): MessageContentPart[] | null {
  return Array.isArray(message.content) ? message.content : null;
}

function boundedPartIndices(length: number, maxParts: number): number[] {
  if (length <= maxParts) return Array.from({ length }, (_, index) => index);
  // Deliberately lossy: inspect both ends without traversing an unbounded middle.
  const firstCount = Math.floor(maxParts / 2);
  const lastStart = length - (maxParts - firstCount);
  return [
    ...Array.from({ length: firstCount }, (_, index) => index),
    ...Array.from(
      { length: length - lastStart },
      (_, index) => lastStart + index,
    ),
  ];
}

function messageText(
  message: ChatMessage,
  maxCodeUnits: number,
  maxParts: number,
  inputBudget: InputBudget,
): string | null {
  if (typeof message.content === "string") {
    const bounded = takeInputText(message.content, maxCodeUnits, inputBudget);
    return bounded.text
      ? sanitizeText(bounded.text, maxCodeUnits, bounded.truncated)
      : null;
  }
  const parts = contentParts(message);
  if (!parts) return null;
  let text = "";
  let sourceTruncated = false;
  const scanLimit = maxCodeUnits + SANITIZER_LOOKAHEAD_CODE_UNITS;
  const partIndices = boundedPartIndices(parts.length, maxParts);
  for (const index of partIndices) {
    const part = parts[index];
    if (!isRecord(part)) continue;
    if (ownValue(part, "type") !== "text") continue;
    const value = ownValue(part, "text");
    if (typeof value === "string") {
      const remaining = Math.min(
        scanLimit - text.length,
        inputBudget.remaining,
      );
      if (remaining <= 0) {
        if (value.length > 0) sourceTruncated = true;
        break;
      }
      text += value.slice(0, remaining);
      inputBudget.remaining -= Math.min(value.length, remaining);
      if (value.length > remaining) {
        sourceTruncated = true;
        break;
      }
    }
  }
  if (parts.length > partIndices.length) sourceTruncated = true;
  return text ? sanitizeText(text, maxCodeUnits, sourceTruncated) : null;
}

function completedToolResult(part: Record<string, unknown>): boolean {
  const state = ownValue(part, "state") ?? ownValue(part, "status");
  if (state === undefined) return true;
  return (
    state === "completed" ||
    state === "complete" ||
    state === "succeeded" ||
    state === "success"
  );
}

function normalizeTextValue(
  value: unknown,
  maxCodeUnits: number,
  inputBudget: InputBudget,
): string | null {
  if (typeof value === "string") {
    const bounded = takeInputText(value, maxCodeUnits, inputBudget);
    return sanitizeText(bounded.text, maxCodeUnits, bounded.truncated);
  }
  return serializeUnknown(value, maxCodeUnits, inputBudget);
}

function normalizeContentOutput(
  value: unknown,
  maxCodeUnits: number,
  inputBudget: InputBudget,
): PromptEditorToolOutputSnapshot | null {
  if (!Array.isArray(value)) return null;
  let text = "";
  let sourceTruncated = false;
  const scanLimit = maxCodeUnits + SANITIZER_LOOKAHEAD_CODE_UNITS;
  const contentLimit = Math.min(value.length, MAX_SAFE_JSON_ITEMS);
  for (let index = 0; index < contentLimit; index += 1) {
    const content = value[index];
    if (!isRecord(content) || ownValue(content, "type") !== "text") continue;
    const contentText = ownValue(content, "text");
    if (typeof contentText !== "string") continue;
    const remaining = Math.min(scanLimit - text.length, inputBudget.remaining);
    if (remaining <= 0) {
      if (contentText.length > 0) sourceTruncated = true;
      break;
    }
    text += contentText.slice(0, remaining);
    inputBudget.remaining -= Math.min(contentText.length, remaining);
    if (contentText.length > remaining) {
      sourceTruncated = true;
      break;
    }
  }
  if (value.length > contentLimit) sourceTruncated = true;
  if (text.length === 0) return null;
  return {
    kind: "content",
    text: sanitizeText(text, maxCodeUnits, sourceTruncated),
  };
}

function normalizeLegacyToolResult(
  part: Record<string, unknown>,
  maxCodeUnits: number,
  inputBudget: InputBudget,
): PromptEditorToolOutputSnapshot | null {
  if (!completedToolResult(part)) return null;
  const result = ownValue(part, "result");
  if (!isRecord(result)) return null;
  const kind = ownValue(result, "type");
  const value = ownValue(result, "value");

  if (kind === "content")
    return normalizeContentOutput(value, maxCodeUnits, inputBudget);

  if (kind !== "text" && kind !== "json" && kind !== "error") return null;
  const text = normalizeTextValue(value, maxCodeUnits, inputBudget);
  if (text === null) return null;
  return { kind, text };
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? sanitizeText(value.trim(), 256)
    : "unknown";
}

function normalizeToolStatus(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? sanitizeText(value.trim(), 64)
    : fallback;
}

function normalizeToolCall(
  part: Record<string, unknown>,
  config: ContextConfig,
  inputBudget: InputBudget,
): PromptEditorToolCallSnapshot | null {
  const type = ownValue(part, "type");
  const includedFields =
    Number(config.contextIncludeToolInputs) +
    Number(config.contextIncludeToolOutputs);
  const fieldMax = Math.max(
    64,
    Math.floor(config.contextToolCallChars / Math.max(1, includedFields)),
  );

  if (type === "tool") {
    const state = ownValue(part, "state");
    if (!isRecord(state)) return null;
    const status = normalizeToolStatus(ownValue(state, "status"), "unknown");
    const input = config.contextIncludeToolInputs
      ? normalizeTextValue(ownValue(state, "input"), fieldMax, inputBudget)
      : null;
    let output: PromptEditorToolOutputSnapshot | null = null;
    if (config.contextIncludeToolOutputs) {
      if (status === "error") {
        const text = normalizeTextValue(
          ownValue(state, "error"),
          fieldMax,
          inputBudget,
        );
        if (text !== null) output = { kind: "error", text };
      } else {
        output = normalizeContentOutput(
          ownValue(state, "content"),
          fieldMax,
          inputBudget,
        );
      }
    }
    return {
      name: normalizeToolName(ownValue(part, "name")),
      status,
      input,
      output,
    };
  }

  if (type === "tool-call") {
    const state = ownValue(part, "state");
    const status = isRecord(state)
      ? normalizeToolStatus(ownValue(state, "status"), "called")
      : normalizeToolStatus(ownValue(part, "status") ?? state, "called");
    const rawInput = isRecord(state)
      ? ownValue(state, "input")
      : (ownValue(part, "input") ?? ownValue(part, "args"));
    return {
      name: normalizeToolName(
        ownValue(part, "name") ??
          ownValue(part, "toolName") ??
          ownValue(part, "tool"),
      ),
      status,
      input: config.contextIncludeToolInputs
        ? normalizeTextValue(rawInput, fieldMax, inputBudget)
        : null,
      output: null,
    };
  }

  if (type === "tool-result") {
    const output = config.contextIncludeToolOutputs
      ? normalizeLegacyToolResult(part, fieldMax, inputBudget)
      : null;
    if (!output && config.contextIncludeToolOutputs) return null;
    return {
      name: normalizeToolName(
        ownValue(part, "name") ?? ownValue(part, "toolName"),
      ),
      status: "completed",
      input: null,
      output,
    };
  }

  return null;
}

interface RawToolOperation {
  call?: Record<string, unknown>;
  result?: Record<string, unknown>;
  combined?: Record<string, unknown>;
}

function collectToolCalls(
  messages: readonly ChatMessage[],
  lowerBound: number,
  currentIndex: number,
  config: ContextConfig,
  inputBudget: InputBudget,
): PromptEditorToolCallSnapshot[] {
  if (config.contextToolCalls === 0) return [];
  const operations: RawToolOperation[] = [];
  const byID = new Map<string, RawToolOperation>();

  for (
    let messageIndex = lowerBound;
    messageIndex < currentIndex;
    messageIndex += 1
  ) {
    const message = messages[messageIndex];
    if (!message) continue;
    const parts = contentParts(message);
    if (!parts) continue;
    for (const partIndex of boundedPartIndices(
      parts.length,
      config.contextPartsPerMessage,
    )) {
      const part = parts[partIndex];
      if (!isRecord(part)) continue;
      const type = ownValue(part, "type");
      if (type === "tool") {
        operations.push({ combined: part });
        continue;
      }
      if (type !== "tool-call" && type !== "tool-result") continue;
      const rawID = ownValue(part, "id") ?? ownValue(part, "callID");
      const id = typeof rawID === "string" ? rawID : null;
      let operation = id ? byID.get(id) : undefined;
      if (!operation) {
        operation = {};
        operations.push(operation);
        if (id) byID.set(id, operation);
      }
      if (type === "tool-call") operation.call = part;
      else operation.result = part;
    }
  }

  const selected = operations.slice(-config.contextToolCalls);
  const normalized: PromptEditorToolCallSnapshot[] = [];
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const operation = selected[index]!;
    if (operation.combined) {
      const call = normalizeToolCall(operation.combined, config, inputBudget);
      if (call) normalized.push(call);
      continue;
    }
    if (operation.call) {
      const call = normalizeToolCall(operation.call, config, inputBudget);
      if (!call) continue;
      const output =
        config.contextIncludeToolOutputs && operation.result
          ? normalizeLegacyToolResult(
              operation.result,
              Math.max(
                64,
                Math.floor(
                  config.contextToolCallChars /
                    Math.max(
                      1,
                      Number(config.contextIncludeToolInputs) +
                        Number(config.contextIncludeToolOutputs),
                    ),
                ),
              ),
              inputBudget,
            )
          : null;
      normalized.push({
        ...call,
        status: operation.result ? "completed" : call.status,
        output,
      });
      continue;
    }
    if (operation.result) {
      const result = normalizeToolCall(operation.result, config, inputBudget);
      if (result) normalized.push(result);
    }
  }
  normalized.reverse();
  return normalized;
}

function currentUserIndex(
  messages: readonly ChatMessage[],
  current: CurrentUserMessage,
): number {
  if (typeof current === "number") {
    return Number.isInteger(current) &&
      current >= 0 &&
      current < messages.length
      ? current
      : -1;
  }
  if (typeof current === "string") {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.id === current) return index;
    }
    return -1;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] === current) return index;
  }
  if (typeof current.id !== "string") return -1;
  return currentUserIndex(messages, current.id);
}

function serializedLength(snapshot: PromptEditorContextSnapshot): number {
  return JSON.stringify(snapshot).length;
}

function boundedSnapshot(
  directory: string,
  userMessages: string[],
  assistantMessages: string[],
  toolCalls: PromptEditorToolCallSnapshot[],
  maxChars: number,
): PromptEditorContextSnapshot | null {
  let textCap = Math.max(
    256,
    ...userMessages.map((text) => text.length),
    ...assistantMessages.map((text) => text.length),
    ...toolCalls.flatMap((call) => [
      call.input?.length ?? 0,
      call.output?.text.length ?? 0,
    ]),
  );
  let snapshot: PromptEditorContextSnapshot = {
    directory: truncateText(directory, 4_096),
    userMessages: [...userMessages],
    assistantMessages: [...assistantMessages],
    toolCalls: toolCalls.map((call) => ({
      ...call,
      output: call.output ? { ...call.output } : null,
    })),
  };

  while (serializedLength(snapshot) > maxChars && textCap > 32) {
    textCap = Math.max(32, Math.floor(textCap * 0.75));
    snapshot = {
      directory: truncateText(snapshot.directory, textCap),
      userMessages: snapshot.userMessages.map((text) =>
        truncateText(text, textCap),
      ),
      assistantMessages: snapshot.assistantMessages.map((text) =>
        truncateText(text, textCap),
      ),
      toolCalls: snapshot.toolCalls.map((call) => ({
        ...call,
        name: truncateText(call.name, textCap),
        status: truncateText(call.status, textCap),
        input: call.input === null ? null : truncateText(call.input, textCap),
        output:
          call.output === null
            ? null
            : { ...call.output, text: truncateText(call.output.text, textCap) },
      })),
    };
  }

  if (serializedLength(snapshot) > maxChars) return null;
  const immutableCalls = snapshot.toolCalls.map((call) =>
    Object.freeze({
      ...call,
      output: call.output ? Object.freeze({ ...call.output }) : null,
    }),
  );
  return Object.freeze({
    directory: snapshot.directory,
    userMessages: Object.freeze([...snapshot.userMessages]),
    assistantMessages: Object.freeze([...snapshot.assistantMessages]),
    toolCalls: Object.freeze(immutableCalls),
  });
}

/**
 * Collect a bounded immutable snapshot from one context-hook event. The caller
 * supplies the directory already resolved for that exact session.
 */
function collectContextSnapshotUnsafe(
  messages: readonly ChatMessage[],
  current: CurrentUserMessage,
  directory: string,
  config: ContextConfig,
): PromptEditorContextSnapshot | null {
  const currentIndex = currentUserIndex(messages, current);
  if (currentIndex < 0 || messages[currentIndex]?.role !== "user") return null;

  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const toolCalls: PromptEditorToolCallSnapshot[] = [];
  const inputBudget: InputBudget = {
    remaining: config.contextInputChars,
  };
  const lowerBound = Math.max(0, currentIndex - config.contextScanMessages);
  for (let index = currentIndex - 1; index >= lowerBound; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (
      message.role === "user" &&
      userMessages.length < config.contextUserMessages
    ) {
      const text = messageText(
        message,
        config.contextUserMessageChars,
        config.contextPartsPerMessage,
        inputBudget,
      );
      if (text !== null) userMessages.push(text);
    }
    if (
      message.role === "assistant" &&
      assistantMessages.length < config.contextAssistantMessages
    ) {
      const text = messageText(
        message,
        config.contextAssistantMessageChars,
        config.contextPartsPerMessage,
        inputBudget,
      );
      if (text !== null) assistantMessages.push(text);
    }
    if (
      userMessages.length >= config.contextUserMessages &&
      assistantMessages.length >= config.contextAssistantMessages
    )
      break;
  }
  userMessages.reverse();
  assistantMessages.reverse();
  toolCalls.push(
    ...collectToolCalls(
      messages,
      lowerBound,
      currentIndex,
      config,
      inputBudget,
    ),
  );
  if (
    userMessages.length === 0 &&
    assistantMessages.length === 0 &&
    toolCalls.length === 0
  )
    return null;
  return boundedSnapshot(
    directory,
    userMessages,
    assistantMessages,
    toolCalls,
    config.contextMaxChars,
  );
}

export function collectContextSnapshot(
  messages: readonly ChatMessage[],
  current: CurrentUserMessage,
  directory: string,
  config: ContextConfig = PROMPT_EDITOR_DEFAULTS,
): PromptEditorContextSnapshot | null {
  try {
    return collectContextSnapshotUnsafe(messages, current, directory, config);
  } catch {
    return null;
  }
}
