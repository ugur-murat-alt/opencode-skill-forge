import { test, expect } from "bun:test";
import {
  HOOK_CAPABILITIES,
  HOOK_NATIVE_TESTED_VERSIONS,
  HOOK_NATIVE_TEST_NOTE,
  buildCheckpointContent,
  hookCapabilityReport,
  installableHookEvents,
  isHookEvent,
  parseHookInput,
  requestsMemoryOff,
  validHookSessionId,
} from "../src/clients/hook-contract.js";
import { hookEventId } from "../src/clients/hook-spool.js";

test("installer registers only the Faz A event set per client", () => {
  expect(installableHookEvents("codex")).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SessionEnd",
  ]);
  expect(installableHookEvents("claude")).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SessionEnd",
  ]);
  // No silent support claims: uninstalled events are reported as degraded or
  // unsupported, and their status is never "supported + installed".
  for (const client of ["codex", "claude"] as const) {
    const report = hookCapabilityReport(client);
    for (const entry of report) {
      if (!entry.installed)
        expect(["degraded", "unsupported"]).toContain(entry.status);
      expect(entry.timeout_seconds).toBeGreaterThan(0);
      expect(entry.timeout_seconds).toBeLessThanOrEqual(10);
    }
    expect(report.find((e) => e.event === "PreCompact")?.installed).toBe(false);
    expect(report.find((e) => e.event === "PostCompact")?.installed).toBe(
      false,
    );
  }
  expect(installableHookEvents("codex")).not.toContain("Interrupt");
  expect(installableHookEvents("claude")).not.toContain("Interrupt");
  // Codex SessionEnd/Interrupt enforce a 3s maximum; the table stays inside.
  for (const event of ["SessionEnd", "Interrupt"] as const)
    expect(HOOK_CAPABILITIES.codex[event].timeoutSeconds).toBeLessThanOrEqual(
      3,
    );
});

test("unsupported events and unsafe identities never parse as handled", () => {
  expect(isHookEvent("PreCompact")).toBe(true);
  expect(isHookEvent("ToolUse")).toBe(false);
  expect(
    parseHookInput("codex", "PreCompact", { session_id: "s-1" }).kind,
  ).toBe("unsupported");
  expect(
    parseHookInput("claude", "Interrupt", { session_id: "s-1" }).kind,
  ).toBe("unsupported");
  expect(
    parseHookInput("claude", "Stop", {
      session_id: "s-1",
      stop_hook_active: true,
    }).kind,
  ).toBe("ignored");
  expect(
    parseHookInput("claude", "Stop", {
      session_id: "s-1",
      agent_id: "sub-1",
    }).kind,
  ).toBe("ignored");
  const handled = parseHookInput("claude", "Stop", {
    session_id: "s-1",
    turn_id: "t-1",
    last_assistant_message: "final",
  });
  expect(handled.kind).toBe("handled");
  if (handled.kind === "handled") {
    expect(handled.envelope.sessionId).toBe("s-1");
    expect(handled.envelope.lastAssistantMessage).toBe("final");
  }
});

test("missing session identity is null, never an 'unknown' pool", () => {
  expect(validHookSessionId(undefined)).toBeNull();
  expect(validHookSessionId("")).toBeNull();
  expect(validHookSessionId("unknown")).toBeNull();
  expect(validHookSessionId("UNKNOWN")).toBeNull();
  expect(validHookSessionId("  session-1  ")).toBe("session-1");
  const parsed = parseHookInput("codex", "Stop", {
    hook_event_name: "Stop",
    last_assistant_message: "x",
  });
  expect(parsed.kind).toBe("handled");
  if (parsed.kind === "handled") expect(parsed.envelope.sessionId).toBeNull();
});

test("[memory:off] is detected case/space-insensitively for the whole turn", () => {
  expect(requestsMemoryOff("please remember [memory:off] this once")).toBe(
    true,
  );
  expect(requestsMemoryOff("[MEMORY: OFF]")).toBe(true);
  expect(requestsMemoryOff("[ memory : off ]")).toBe(true);
  expect(requestsMemoryOff("memory off")).toBe(false);
  expect(requestsMemoryOff("[memory:on]")).toBe(false);
});

test("hook event identity is deterministic and content-bound", () => {
  const base = {
    installationId: "a".repeat(64),
    projectRef: "project-1",
    client: "codex" as const,
    event: "Stop",
    sessionId: "s-1",
    turnRef: "t-1",
    worktreeKey: "w-1",
    contentHash: "c".repeat(64),
  };
  expect(hookEventId(base)).toBe(hookEventId({ ...base }));
  expect(hookEventId(base)).not.toBe(
    hookEventId({ ...base, contentHash: "d".repeat(64) }),
  );
  expect(hookEventId(base)).not.toBe(
    hookEventId({ ...base, worktreeKey: "w-2" }),
  );
  expect(hookEventId(base)).toMatch(/^[a-f0-9]{64}$/);
});

test("checkpoint content is factual, bounded and never certifies tests", () => {
  const content = buildCheckpointContent({
    client: "claude",
    sessionId: "session-1",
    turnRef: "turn-1",
    worktreeKey: "abc123",
    observedAt: 1_700_000_000_000,
    summary: "x".repeat(10_000),
  });
  expect(content).toContain("# Oturum checkpoint'i — claude");
  expect(content).toContain("- oturum: session-1");
  expect(content).toContain("- çalışma alanı: abc123");
  expect(content).toContain("test/görev durumu otomatik doğrulanmaz");
  expect(content).not.toContain("tests passed");
  expect(content).not.toContain("transcript");
  expect(content.length).toBeLessThanOrEqual(8000 + 400);
});

test("native client versions are explicitly untested in this environment", () => {
  expect(HOOK_NATIVE_TESTED_VERSIONS.codex).toBeNull();
  expect(HOOK_NATIVE_TESTED_VERSIONS.claude).toBeNull();
  expect(HOOK_NATIVE_TEST_NOTE).toContain("yapılmadı");
});
