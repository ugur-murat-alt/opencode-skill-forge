import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  PROMPT_EDITOR_FLAG_DEFAULTS,
  requestsFile,
  type PromptEditorRequest,
  type PromptEditorSessionFlags,
} from "../legacy-runtime/prompt-editor/live.js";

export function writeSessionFlags(
  file: string,
  sessionID: string,
  patch: Partial<PromptEditorSessionFlags>,
): PromptEditorSessionFlags {
  let parsed: Record<string, Partial<PromptEditorSessionFlags>> = {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      parsed = value as Record<string, Partial<PromptEditorSessionFlags>>;
  } catch {
    // Start a fresh test fixture.
  }
  const previous = parsed[sessionID] ?? {};
  const next = {
    enabled:
      patch.enabled ?? previous.enabled ?? PROMPT_EDITOR_FLAG_DEFAULTS.enabled,
    autoAccept:
      patch.autoAccept ??
      previous.autoAccept ??
      PROMPT_EDITOR_FLAG_DEFAULTS.autoAccept,
  };
  parsed[sessionID] = next;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, JSON.stringify(parsed), { mode: 0o600 });
  renameSync(temporary, file);
  return next;
}

export function enqueueRequest(request: PromptEditorRequest): void {
  const file = requestsFile();
  mkdirSync(dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // New test fixture.
  }
  const kept = existing.split("\n").filter(Boolean).slice(-199);
  kept.push(JSON.stringify(request));
  writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
}
