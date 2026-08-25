import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promptEditorStateDir } from "./paths.js";

/** Entry persisted for every successful rewrite so UIs (e.g. opencode2-web)
 *  can display the improved prompt next to the user's original message. */
export interface RewriteRecord {
  ts: number;
  sessionID: string;
  messageID: string;
  outcome: "rewritten";
  original: string;
  rewritten: string;
  model?: string | null;
  durationMs: number;
  /** Whether the rewrite was applied to the intercepted provider dispatch. */
  applied?: boolean;
}

/** Keep the newest 200 rewrites so the file stays small and bounded. */
export const REWRITES_MAX_ENTRIES = 200;

export function rewritesFile(): string {
  return joinPath(promptEditorStateDir(), "rewrites.jsonl");
}

function joinPath(a: string, b: string): string {
  return `${a.replace(/\/$/, "")}/${b}`;
}

/**
 * Append a rewrite record, trimming the file to the newest N entries.
 * Fail-open: never throws (UI display is strictly additive).
 */
export function appendRewrite(file: string, record: RewriteRecord): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    let existing = "";
    try {
      existing = readFileSync(file, "utf8");
    } catch {
      // new file
    }
    const kept = existing
      .split("\n")
      .filter(Boolean)
      .filter((entry) => {
        try {
          const parsed = JSON.parse(entry) as Partial<RewriteRecord>;
          return !(
            parsed.sessionID === record.sessionID &&
            parsed.messageID === record.messageID
          );
        } catch {
          return false;
        }
      })
      .slice(-(REWRITES_MAX_ENTRIES - 1));
    const content = kept.length > 0 || existing ? `${kept.join("\n")}\n${line}` : line;
    writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Never block the message pipeline.
  }
}

/** Read newest-first rewrite records (for the web bridge). */
export function readRewrites(file: string, limit = REWRITES_MAX_ENTRIES): RewriteRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: RewriteRecord[] = [];
  for (const line of raw.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RewriteRecord;
      if (parsed && typeof parsed.rewritten === "string" && typeof parsed.original === "string") {
        out.push(parsed);
        if (out.length >= limit) break;
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
