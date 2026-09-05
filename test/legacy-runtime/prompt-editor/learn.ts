import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { sanitizePromptEditorText } from "./context-snapshot.js";

export interface LearningEntry {
  ts: number;
  /** Raw lesson text (capped per entry by prompt-editor config). */
  text: string;
}

export const DEFAULT_LEARN_ENTRY_MAX_CHARS = 5_000;

const HEADER = "# Prompt Editor — Learn\n";

/**
 * Load the global learn.md as structured entries (newest last). Never throws.
 */
export function loadLearnFile(file: string): LearningEntry[] {
  try {
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf8");
    const blocks = raw.split(/\n#{2,}\s*/).slice(1);
    const entries: LearningEntry[] = [];
    for (const block of blocks) {
      const newline = block.indexOf("\n");
      const head = (newline === -1 ? block : block.slice(0, newline)).trim();
      const body = (newline === -1 ? "" : block.slice(newline + 1)).trim();
      const tsMatch = /^\[(\d{10,13})\]/.exec(head);
      if (body)
        entries.push({
          ts: tsMatch ? Number(tsMatch[1]) : Date.now(),
          text: sanitizePromptEditorText(body, body.length),
        });
    }
    return entries;
  } catch {
    return [];
  }
}

function serializeEntries(entries: LearningEntry[]): string {
  // Oldest first so the file is append-ordered (chronological, newest last).
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const parts: string[] = [HEADER];
  for (const e of sorted) {
    parts.push("");
    parts.push(`## [${e.ts}]`);
    parts.push(e.text);
  }
  return parts.join("\n");
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * Append a learning entry, then enforce the size cap by trimming oldest
 * entries (a single oversized entry drains to just the header). Returns the
 * number of live entries after append, or -1 on failure.
 */
export function appendLearning(
  file: string,
  text: string,
  maxBytes: number,
  maxEntryChars = DEFAULT_LEARN_ENTRY_MAX_CHARS,
): number {
  const bounded = Array.from(text.trim()).slice(0, maxEntryChars).join("");
  const trimmed = sanitizePromptEditorText(bounded, bounded.length).trim();
  const current = loadLearnFile(file);
  if (!trimmed) return current.length;
  const next = [...current, { ts: Date.now(), text: trimmed }];

  let content = serializeEntries(next);
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    // Drop oldest entries from the front until the file fits, keeping the
    // most recent knowledge.
    const oldestFirst = [...next].sort((a, b) => a.ts - b.ts);
    let fit = "";
    for (let drop = 0; drop <= oldestFirst.length; drop++) {
      const candidate = serializeEntries(oldestFirst.slice(drop));
      if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
        fit = candidate;
        break;
      }
    }
    content = fit || HEADER;
  }

  try {
    atomicWrite(file, content);
  } catch {
    return -1;
  }
  return loadLearnFile(file).length;
}

/** Short preview of the newest lesson (for logs/debug). */
export function learnPreview(file: string, max = 240): string {
  const entries = loadLearnFile(file);
  if (entries.length === 0) return "";
  const last = entries[entries.length - 1]!.text;
  return last.length > max ? `${last.slice(0, max)}…` : last;
}
