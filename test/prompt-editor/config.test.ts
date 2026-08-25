import { describe, expect, test } from "bun:test";
import {
  PROMPT_EDITOR_DEFAULTS,
  resolvePromptEditorOptions,
} from "../../src/prompt-editor/config.js";

describe("resolvePromptEditorOptions", () => {
  test("defaults enforce thorough rewriting with a finite run deadline", () => {
    const cfg = resolvePromptEditorOptions(undefined);
    expect(cfg.enabled).toBe(false);
    expect(PROMPT_EDITOR_DEFAULTS.maxSteps).toBe(30);
    expect(cfg.maxSteps).toBe(30);
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.rewriteMode).toBe("always");
    expect(cfg.detailLevel).toBe("thorough");
    expect(cfg.correctWriting).toBe(true);
    expect(cfg.learningMode).toBe("always");
    expect(cfg.blocking).toBe(true);
    expect(cfg.minChars).toBe(1);
    expect(cfg.maxChars).toBe(200_000);
    expect(cfg.learnEntryMaxChars).toBe(5_000);
    expect(cfg.persist).toBe(true);
    expect(cfg.model).toBeNull();
  });

  test("enabled via options.promptEditor.enabled regardless of master flag", () => {
    expect(resolvePromptEditorOptions({ enabled: false }).enabled).toBe(false);
    expect(resolvePromptEditorOptions({ enabled: true }).enabled).toBe(false);
    expect(
      resolvePromptEditorOptions({ promptEditor: { enabled: true } }).enabled,
    ).toBe(true);
    expect(
      resolvePromptEditorOptions({ promptEditor: { enabled: false } }).enabled,
    ).toBe(false);
  });

  test("model/variant are picked up", () => {
    const cfg = resolvePromptEditorOptions({
      promptEditor: { model: "acme/fast", variant: "low" },
    });
    expect(cfg.model).toBe("acme/fast");
    expect(cfg.variant).toBe("low");
  });

  test("blocking defaults true and can be explicitly disabled", () => {
    expect(
      resolvePromptEditorOptions({ promptEditor: { enabled: true } }).blocking,
    ).toBe(true);
    expect(
      resolvePromptEditorOptions({ promptEditor: { blocking: false } })
        .blocking,
    ).toBe(false);
  });

  test("maxSteps preserves valid overrides and clamps to 1..100", () => {
    expect(
      resolvePromptEditorOptions({ promptEditor: { maxSteps: 42 } }).maxSteps,
    ).toBe(42);
    expect(
      resolvePromptEditorOptions({ promptEditor: { maxSteps: 0 } }).maxSteps,
    ).toBe(1);
    expect(
      resolvePromptEditorOptions({ promptEditor: { maxSteps: 1000 } }).maxSteps,
    ).toBe(100);
  });

  test("timeout rejects unbounded values and clamps positive values", () => {
    expect(
      resolvePromptEditorOptions({ promptEditor: { timeoutMs: 0 } }).timeoutMs,
    ).toBe(30_000);
    const cfg = resolvePromptEditorOptions({ promptEditor: { timeoutMs: 1 } });
    expect(cfg.timeoutMs).toBe(1_000); // min floor
    expect(
      resolvePromptEditorOptions({ promptEditor: { timeoutMs: 999_999 } })
        .timeoutMs,
    ).toBe(120_000);
  });

  test("maxChars defaults and clamps", () => {
    expect(PROMPT_EDITOR_DEFAULTS.maxChars).toBe(200_000);
    const low = resolvePromptEditorOptions({
      promptEditor: { enabled: true, maxChars: 5 },
    });
    expect(low.maxChars).toBe(1_000); // min floor
    const high = resolvePromptEditorOptions({
      promptEditor: { enabled: true, maxChars: 999_999 },
    });
    expect(high.maxChars).toBe(200_000); // max ceiling
  });

  test("all rewrite, context, lifecycle, and learning controls are configurable", () => {
    const cfg = resolvePromptEditorOptions({
      promptEditor: {
        directoryTimeoutMs: 9_000,
        cleanupTimeoutMs: 8_000,
        description: "Configured editor",
        defaultSessionEnabled: false,
        defaultAutoAccept: false,
        rewriteMode: "when-needed",
        detailLevel: "concise",
        correctWriting: false,
        learningMode: "off",
        contextUserMessages: 4,
        contextAssistantMessages: 5,
        contextToolCalls: 6,
        contextUserMessageChars: 7_000,
        contextAssistantMessageChars: 8_000,
        contextToolCallChars: 9_000,
        contextMaxChars: 100_000,
        contextScanMessages: 700,
        contextPartsPerMessage: 70,
        contextInputChars: 300_000,
        contextIncludeToolInputs: false,
        contextIncludeToolOutputs: false,
        learnEntryMaxChars: 4_000,
        learnMaxBytes: 500_000,
        learnContextMaxChars: 60_000,
      },
    });

    expect(cfg).toMatchObject({
      directoryTimeoutMs: 9_000,
      cleanupTimeoutMs: 8_000,
      description: "Configured editor",
      defaultSessionEnabled: false,
      defaultAutoAccept: false,
      rewriteMode: "when-needed",
      detailLevel: "concise",
      correctWriting: false,
      learningMode: "off",
      contextUserMessages: 4,
      contextAssistantMessages: 5,
      contextToolCalls: 6,
      contextUserMessageChars: 7_000,
      contextAssistantMessageChars: 8_000,
      contextToolCallChars: 9_000,
      contextMaxChars: 100_000,
      contextScanMessages: 700,
      contextPartsPerMessage: 70,
      contextInputChars: 300_000,
      contextIncludeToolInputs: false,
      contextIncludeToolOutputs: false,
      learnEntryMaxChars: 4_000,
      learnMaxBytes: 500_000,
      learnContextMaxChars: 60_000,
    });
  });

  test("aggregate context cap preserves configured item skeletons", () => {
    const cfg = resolvePromptEditorOptions({
      promptEditor: {
        contextUserMessages: 3,
        contextAssistantMessages: 3,
        contextToolCalls: 10,
        contextMaxChars: 1_024,
      },
    });
    expect(cfg.contextMaxChars).toBeGreaterThan(1_024);
  });

  test("tools are sanitized: write-capable tools are stripped", () => {
    const cfg = resolvePromptEditorOptions({
      promptEditor: {
        tools: ["READ", "read", "grep", "edit", "bash", "custom", "glob"],
      },
    });
    expect(cfg.tools).toEqual(["read", "grep", "glob"]);
    expect(
      resolvePromptEditorOptions({ promptEditor: { tools: [] } }).tools,
    ).toEqual([]);
  });

  test("malformed tools array falls back to defaults", () => {
    const cfg = resolvePromptEditorOptions({
      promptEditor: { tools: [123, "read"] },
    });
    expect(cfg.tools).toEqual(PROMPT_EDITOR_DEFAULTS.tools);
  });
});
