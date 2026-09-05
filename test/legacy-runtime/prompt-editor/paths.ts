import { homedir } from "node:os";
import { join } from "node:path";

/** Global prompt-editor state root (mirrors skill-forge's globalRoot convention). */
export function promptEditorStateDir(): string {
  const home = process.env.OC_SKILL_POWER_HOME ?? homedir();
  return join(home, ".opencode", ".skill-power", "prompt-editor");
}

export function defaultLearnFile(): string {
  return join(promptEditorStateDir(), "learn.md");
}

export function journalFile(): string {
  return join(promptEditorStateDir(), "journal.jsonl");
}
