/**
 * Wrapper-only `spr` options block. Mirrors the promptEditor.model pattern:
 * an explicit model override for the skill-forge SPR reviewer without
 * touching the preserved core bundle.
 *
 * - `spr.model` maps onto the core's existing `reviewModel` option (which the
 *   core validates and applies when launching review sessions).
 * - `spr.variant` additionally updates the registered `spr` agent definition.
 * - `spr.allowedAgents` limits which agent sessions receive the final-step
 *   handoff instruction and tool (default: general, plan, build).
 * Invalid values are warned about and ignored so plugin setup never fails.
 */
export interface SprOptions {
  model?: string;
  variant?: string;
  allowedAgents?: string[];
}

export const DEFAULT_SPR_ALLOWED_AGENTS = ["general", "plan", "build"];

const MODEL_PATTERN = /^.+\/.+$/;

export function parseSprOptions(raw: unknown): SprOptions | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const block = (raw as Record<string, unknown>)["spr"];
  if (!block || typeof block !== "object" || Array.isArray(block))
    return undefined;
  const record = block as Record<string, unknown>;
  const out: SprOptions = {};
  if (typeof record["model"] === "string" && record["model"]) {
    if (MODEL_PATTERN.test(record["model"])) out.model = record["model"];
    else
      console.warn(
        `[skill-forge] spr.model "${record["model"]}" is not a valid "provider/model" reference; ignoring`,
      );
  }
  if (typeof record["variant"] === "string" && record["variant"])
    out.variant = record["variant"];
  if ("allowedAgents" in record) {
    if (!Array.isArray(record["allowedAgents"])) {
      console.warn(
        "[skill-forge] spr.allowedAgents must be an array of agent IDs; disabling SPR handoff",
      );
      out.allowedAgents = [];
    } else {
      out.allowedAgents = [
        ...new Set(
          record["allowedAgents"]
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
