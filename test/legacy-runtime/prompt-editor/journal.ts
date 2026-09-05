import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JournalEntry } from "./types.js";

/**
 * Append-only telemetry for every prompt-editor run. Never logs secrets.
 */
export function appendJournal(file: string, entry: JournalEntry): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Never block the message pipeline on telemetry failures.
  }
}

export function readJournal(file: string, limit = 1000): JournalEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean).slice(-limit);
  const out: JournalEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as JournalEntry | null;
      if (parsed) out.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
