export type CoreOptions = Record<string, unknown>;

import { parseSprOptions } from "./spr-options.js";

function isRecord(value: unknown): value is CoreOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Produces the flat options object expected by the preserved skill-forge core.
 * Nested `skills` settings override outer settings, while wrapper-only options
 * are not forwarded to the core. An explicit `spr.model` maps onto the core's
 * existing `reviewModel` knob and takes precedence over legacy values. The
 * preserved core receives a one-step trigger because it only sees bounded
 * handoff sessions; real owner sessions are filtered by the wrapper runtime.
 */
export function normalizeCoreOptions(raw: unknown): CoreOptions | undefined {
  if (!isRecord(raw)) return undefined;

  const spr = parseSprOptions(raw);
  const {
    promptEditor: _promptEditor,
    spr: _spr,
    skills: rawSkills,
    ...outerOptions
  } = raw;
  let merged: CoreOptions;
  if (!isRecord(rawSkills)) merged = outerOptions;
  else {
    const {
      promptEditor: _nestedPromptEditor,
      spr: _nestedSpr,
      skills: _nestedSkills,
      ...nestedOptions
    } = rawSkills;
    merged = { ...outerOptions, ...nestedOptions };
  }
  const normalized = {
    ...merged,
    trigger: {
      stepThreshold: 1,
      endOfSessionMinSteps: 1,
      explicitImmediate: true,
    },
  };
  return spr?.model ? { ...normalized, reviewModel: spr.model } : normalized;
}
