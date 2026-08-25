import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendState,
  readStates,
  latestStatesPerMessage,
  readSessionFlags,
  PROMPT_EDITOR_FLAG_DEFAULTS,
  PROMPT_EDITOR_STATES_LIMIT,
  readRequests,
  statesFile,
  requestsFile,
  cancelOrphanedManualStates,
} from "../../src/prompt-editor/live.js";
import { enqueueRequest, writeSessionFlags } from "./helpers.js";

let sandbox: string;
let previous: string | undefined;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "pe-live-"));
  previous = process.env.OC_SKILL_POWER_HOME;
  process.env.OC_SKILL_POWER_HOME = sandbox;
});
afterAll(() => {
  if (previous === undefined) delete process.env.OC_SKILL_POWER_HOME;
  else process.env.OC_SKILL_POWER_HOME = previous;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("prompt-editor live state", () => {
  test("appendState writes newest-last and readStates returns newest-first", () => {
    appendState({
      ts: 1,
      sessionID: "s1",
      messageID: "m1",
      phase: "editing",
      original: "a",
    });
    appendState({
      ts: 2,
      sessionID: "s1",
      messageID: "m1",
      phase: "completed",
      rewritten: "b",
    });
    appendState({ ts: 3, sessionID: "s2", messageID: "m9", phase: "editing" });

    const states = readStates(statesFile());
    expect(states[0]).toMatchObject({ sessionID: "s2", phase: "editing" });
    expect(states[1]).toMatchObject({ sessionID: "s1", phase: "completed" });
    expect(states[2]).toMatchObject({ sessionID: "s1", phase: "editing" });
  });

  test("latestStatesPerMessage keeps the newest phase per message", () => {
    appendState({
      ts: 1,
      sessionID: "s1",
      messageID: "m-latest",
      phase: "editing",
    });
    appendState({
      ts: 2,
      sessionID: "s1",
      messageID: "m-latest",
      phase: "accepted",
    });
    const map = latestStatesPerMessage(statesFile());
    expect(map.get("s1|m-latest")).toMatchObject({ phase: "accepted" });
    expect(map.size).toBeGreaterThan(0);
  });

  test("session flags default to enabled + autoAccept and persist patches", () => {
    const file = join(sandbox, "session-flags-default.json");
    expect(readSessionFlags(file, "s1")).toEqual(PROMPT_EDITOR_FLAG_DEFAULTS);
    const next = writeSessionFlags(file, "s1", { enabled: false });
    expect(next.enabled).toBe(false);
    expect(next.autoAccept).toBe(true);
    expect(readSessionFlags(file, "s1").enabled).toBe(false);
    // Other sessions unaffected.
    expect(readSessionFlags(file, "s2").enabled).toBe(true);
    // Only patch the given field.
    const acceptOff = writeSessionFlags(file, "s1", { autoAccept: false });
    expect(acceptOff.enabled).toBe(false);
    expect(acceptOff.autoAccept).toBe(false);
  });

  test("session flag defaults can come from plugin configuration", () => {
    const file = join(sandbox, "session-flags-configured.json");
    const defaults = { enabled: false, autoAccept: false };
    expect(readSessionFlags(file, "new", defaults)).toEqual(defaults);
    writeFileSync(
      file,
      JSON.stringify({ existing: { enabled: true } }),
      "utf8",
    );
    expect(readSessionFlags(file, "new", defaults)).toEqual(defaults);
  });

  test("corrupt existing flags fail closed to manual approval", () => {
    const file = join(sandbox, "session-flags-corrupt.json");
    writeFileSync(file, "{not-json", "utf8");
    expect(readSessionFlags(file, "s-corrupt")).toEqual({
      enabled: true,
      autoAccept: false,
    });
  });

  test("valid JSON with malformed flag shapes also fails closed", () => {
    const file = join(sandbox, "session-flags-malformed.json");
    writeFileSync(
      file,
      JSON.stringify({ scalar: true, typed: { autoAccept: "false" } }),
      "utf8",
    );
    expect(readSessionFlags(file, "scalar").autoAccept).toBe(false);
    expect(readSessionFlags(file, "typed").autoAccept).toBe(false);
  });

  test("enqueueRequest then readRequests returns and dedups", () => {
    enqueueRequest({
      protocolVersion: 2,
      kind: "re-evaluate",
      sessionID: "s1",
      messageID: "m1",
      gateID: "gate-test-1",
      revision: 1,
      ts: 10,
    });
    enqueueRequest({
      protocolVersion: 2,
      kind: "accept",
      sessionID: "s1",
      messageID: "m1",
      gateID: "gate-test-1",
      revision: 2,
      ts: 11,
    });
    const file = requestsFile();
    const seen = new Set<string>();
    const reqs = readRequests(file, seen);
    expect(reqs.map((r) => r.kind)).toEqual(["re-evaluate", "accept"]);
    // Same ids already seen -> skipped on a second read.
    expect(readRequests(file, seen)).toEqual([]);
  });

  test("legacy requests cannot be replayed into the manual gate", () => {
    enqueueRequest({
      protocolVersion: 1,
      kind: "accept",
      sessionID: "s1",
      messageID: "m1",
      gateID: "gate-test-1",
      revision: 1,
      ts: 12,
    } as never);
    expect(
      readRequests(requestsFile(), new Set()).some(
        (request) => request.ts === 12,
      ),
    ).toBe(false);
  });

  test("startup cancels orphaned v2 manual gates without dispatching them", () => {
    appendState({
      protocolVersion: 2,
      ts: 20,
      sessionID: "s-orphan",
      messageID: "m-orphan",
      phase: "awaiting-decision",
      revision: 1,
      autoAccept: false,
      original: "Original",
      rewritten: "Candidate",
    });
    expect(cancelOrphanedManualStates()).toBe(1);
    expect(
      latestStatesPerMessage(statesFile()).get("s-orphan|m-orphan"),
    ).toMatchObject({
      phase: "cancelled",
      error: "approval_gate_restarted",
      revision: 1,
    });
    expect(cancelOrphanedManualStates()).toBe(0);
  });

  test("startup also cancels a manual editor interrupted before candidate creation", () => {
    appendState({
      protocolVersion: 2,
      ts: 30,
      sessionID: "s-editing",
      messageID: "m-editing",
      phase: "editing",
      autoAccept: false,
      original: "Original",
    });
    expect(cancelOrphanedManualStates()).toBe(1);
    expect(
      latestStatesPerMessage(statesFile()).get("s-editing|m-editing"),
    ).toMatchObject({
      phase: "cancelled",
      error: "approval_gate_restarted",
    });
  });

  test("active manual gates survive lifecycle telemetry rollover", () => {
    appendState({
      protocolVersion: 2,
      ts: 100,
      sessionID: "s-active",
      messageID: "m-active",
      phase: "awaiting-decision",
      autoAccept: false,
      gateID: "gate-active-1",
      revision: 1,
      original: "Original",
      rewritten: "Candidate",
    });
    for (let index = 0; index < PROMPT_EDITOR_STATES_LIMIT + 20; index += 1) {
      appendState({
        ts: 101 + index,
        sessionID: `s-${index}`,
        messageID: `m-${index}`,
        phase: "completed",
        autoAccept: true,
      });
    }
    expect(readStates(statesFile())).toHaveLength(PROMPT_EDITOR_STATES_LIMIT);
    expect(
      latestStatesPerMessage(statesFile()).get("s-active|m-active"),
    ).toMatchObject({
      phase: "awaiting-decision",
      gateID: "gate-active-1",
    });
  });

  test("unknown request kinds are ignored before reaching the gate", () => {
    enqueueRequest({
      protocolVersion: 2,
      kind: "approve-all",
      sessionID: "s1",
      messageID: "m1",
      gateID: "gate-test-1",
      revision: 1,
      ts: 40,
    } as never);
    expect(
      readRequests(requestsFile(), new Set()).some(
        (request) => request.ts === 40,
      ),
    ).toBe(false);
  });
});
