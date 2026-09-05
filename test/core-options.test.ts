import { describe, expect, test } from "bun:test";
import { resolveOptions } from "./fixtures/legacy/skillforge-core.js";
import { normalizeCoreOptions } from "../src/core-options.js";

const HANDOFF_TRIGGER = {
  stepThreshold: 1,
  endOfSessionMinSteps: 1,
  explicitImmediate: true,
};

describe("normalizeCoreOptions", () => {
  test("replaces legacy transcript triggers with the bounded handoff trigger", () => {
    const raw = {
      enabled: true,
      evolutionMode: "active",
      skills: {
        trigger: {
          stepThreshold: 100,
          endOfSessionMinSteps: 10,
          explicitImmediate: true,
        },
      },
    };

    const normalized = normalizeCoreOptions(raw);
    const { config } = resolveOptions(normalized);

    expect(config.enabled).toBe(true);
    expect(config.evolutionMode).toBe("active");
    expect(config.trigger).toEqual(HANDOFF_TRIGGER);
  });

  test("gives nested skills settings precedence over outer settings", () => {
    const normalized = normalizeCoreOptions({
      enabled: false,
      evolutionMode: "off",
      skillsScope: "project",
      trigger: { stepThreshold: 25 },
      skills: {
        enabled: true,
        evolutionMode: "active",
        skillsScope: "global",
        trigger: { stepThreshold: 200 },
      },
    });

    expect(normalized).toEqual({
      enabled: true,
      evolutionMode: "active",
      skillsScope: "global",
      trigger: HANDOFF_TRIGGER,
    });
  });

  test("keeps outer core settings when skills is empty", () => {
    const raw = {
      enabled: true,
      evolutionMode: "active",
      skillsScope: "project",
      writeApproval: false,
      dryRun: false,
      backoff: { maxFailures: 4, cooldownMs: 2_000 },
      churn: { maxMutations: 2, windowHours: 12 },
      trigger: { stepThreshold: 75 },
      skills: {},
    };

    expect(normalizeCoreOptions(raw)).toEqual({
      enabled: true,
      evolutionMode: "active",
      skillsScope: "project",
      writeApproval: false,
      dryRun: false,
      backoff: { maxFailures: 4, cooldownMs: 2_000 },
      churn: { maxMutations: 2, windowHours: 12 },
      trigger: HANDOFF_TRIGGER,
    });
  });

  test("excludes wrapper options without mutating the input", () => {
    const raw = {
      enabled: true,
      promptEditor: { enabled: true },
      skills: {
        promptEditor: { enabled: false },
        skills: { ignored: true },
        trigger: { stepThreshold: 150 },
      },
    };
    const before = structuredClone(raw);

    const normalized = normalizeCoreOptions(raw);

    expect(normalized).toEqual({
      enabled: true,
      trigger: HANDOFF_TRIGGER,
    });
    expect(normalized).not.toHaveProperty("promptEditor");
    expect(normalized).not.toHaveProperty("skills");
    expect(raw).toEqual(before);
  });

  test("maps an explicit spr model onto the core reviewModel", () => {
    const normalized = normalizeCoreOptions({
      enabled: true,
      reviewModel: "legacy/a",
      spr: { model: "p/m", variant: "v" },
      skills: { reviewModel: "nested/b" },
    });
    expect(normalized).toEqual({
      enabled: true,
      reviewModel: "p/m",
      trigger: HANDOFF_TRIGGER,
    });
  });

  test("leaves options untouched without an spr block", () => {
    expect(normalizeCoreOptions({ reviewModel: "auto" })).toEqual({
      reviewModel: "auto",
      trigger: HANDOFF_TRIGGER,
    });
  });

  test("returns undefined for non-object and array inputs", () => {
    expect(normalizeCoreOptions(undefined)).toBeUndefined();
    expect(normalizeCoreOptions(null)).toBeUndefined();
    expect(normalizeCoreOptions([])).toBeUndefined();
  });
});
