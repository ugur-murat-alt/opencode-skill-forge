import { describe, expect, test } from "bun:test";
import { ApprovalGateRegistry } from "../../src/prompt-editor/approval-gate.js";
import type { PromptEditorRequest } from "../../src/prompt-editor/live.js";

const request = (
  kind: PromptEditorRequest["kind"],
  gateID: string,
  revision = 1,
): PromptEditorRequest => ({
  protocolVersion: 2,
  kind,
  sessionID: "ses_1",
  messageID: "msg_1",
  gateID,
  revision,
  ts: Date.now(),
});

describe("ApprovalGateRegistry", () => {
  test("accept resolves exactly once and conflicting decisions lose", async () => {
    const gates = new ApprovalGateRegistry();
    const gate = gates.open("ses_1", "msg_1", {
      original: "Original",
      rewritten: "Improved",
    });
    const waiting = gates.wait("ses_1", "msg_1")!;

    expect(gates.request(request("accept", gate.gateID)).kind).toBe("accepted");
    expect(gates.request(request("reject", gate.gateID)).kind).toBe("busy");
    expect(await waiting).toMatchObject({
      kind: "accept",
      candidate: { rewritten: "Improved", phase: "accepted" },
    });
  });

  test("re-evaluation invalidates old decisions and replaces the candidate", () => {
    const gates = new ApprovalGateRegistry();
    const gate = gates.open("ses_1", "msg_1", {
      original: "Original",
      rewritten: "First",
    });
    const started = gates.request(request("re-evaluate", gate.gateID));
    expect(started).toMatchObject({
      kind: "re-evaluate",
      candidate: { revision: 2, phase: "re-evaluating" },
    });
    expect(gates.request(request("accept", gate.gateID, 1)).kind).toBe("stale");
    expect(
      gates.finishReevaluation("ses_1", "msg_1", 2, {
        original: "Original",
        rewritten: "Second",
      }),
    ).toMatchObject({ revision: 2, rewritten: "Second", phase: "awaiting-decision" });
    expect(gates.request(request("accept", gate.gateID, 2)).kind).toBe("accepted");
  });

  test("shutdown cancellation releases the waiter without accepting text", async () => {
    const gates = new ApprovalGateRegistry();
    gates.open("ses_1", "msg_1", {
      original: "Original",
      rewritten: null,
    });
    const waiting = gates.wait("ses_1", "msg_1")!;
    gates.cancelAll();
    expect(await waiting).toMatchObject({ kind: "cancel" });
    expect(gates.activeCount()).toBe(1);
    gates.close("ses_1", "msg_1");
    expect(gates.activeCount()).toBe(0);
  });

  test("a failed editor candidate cannot be accepted but can send the original", async () => {
    const gates = new ApprovalGateRegistry();
    const gate = gates.open("ses_1", "msg_1", {
      original: "Original",
      rewritten: null,
    });
    const waiting = gates.wait("ses_1", "msg_1")!;
    expect(gates.request(request("accept", gate.gateID)).kind).toBe("busy");
    expect(gates.request(request("reject", gate.gateID)).kind).toBe("rejected");
    expect(await waiting).toMatchObject({ kind: "reject" });
  });

  test("a request from a gate before restart cannot authorize a reopened gate", () => {
    const gates = new ApprovalGateRegistry();
    const oldGate = gates.open("ses_1", "msg_1", {
      original: "Original",
      rewritten: "Old candidate",
    });
    gates.cancel("ses_1", "msg_1");
    gates.close("ses_1", "msg_1");
    const newGate = gates.open("ses_1", "msg_1", {
      original: "Original",
      rewritten: "New candidate",
    });
    expect(newGate.gateID).not.toBe(oldGate.gateID);
    expect(gates.request(request("accept", oldGate.gateID)).kind).toBe("stale");
    expect(gates.get("ses_1", "msg_1")?.phase).toBe("awaiting-decision");
  });
});
