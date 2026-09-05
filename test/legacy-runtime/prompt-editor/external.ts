import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Mirrors the skill-forge external-roles guard: goal-orchestrator sessions
 *  (a sibling plugin in the user's stack) must never be rewritten. */
const GOAL_ROLE_NAMES = new Set([
  "goal-planner",
  "goal-evaluator",
  "goal-skeptic",
  "goal-strategist",
]);

export function isHostIsolatedSession(sessionID: string): boolean {
  try {
    const root = process.env.OC_GOAL_ROLE_REGISTRY_ROOT ?? homedir();
    const file =
      process.env.OC_GOAL_ROLE_REGISTRY ??
      join(root, ".opencode", "goal-orchestrator", "roles.json");
    if (!existsSync(file)) return false;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      schemaVersion?: unknown;
      sessions?: Record<string, { sessionID?: unknown; role?: unknown }>;
    };
    if (parsed.schemaVersion !== 1 || !parsed.sessions) return false;
    const record = parsed.sessions[sessionID];
    return Boolean(
      record &&
      record.sessionID === sessionID &&
      typeof record.role === "string" &&
      GOAL_ROLE_NAMES.has(record.role),
    );
  } catch {
    return false;
  }
}
