import { randomUUID } from "node:crypto";
import type { PromptEditorRequest } from "./live.js";

export interface ApprovalCandidate {
  original: string;
  rewritten: string | null;
  learn?: string;
}

export interface ApprovalSnapshot extends ApprovalCandidate {
  sessionID: string;
  messageID: string;
  gateID: string;
  revision: number;
  phase:
    | "awaiting-decision"
    | "re-evaluating"
    | "accepted"
    | "rejected"
    | "cancelled";
}

export type ApprovalDecision =
  | { kind: "accept"; candidate: ApprovalSnapshot }
  | { kind: "reject"; candidate: ApprovalSnapshot }
  | { kind: "cancel"; candidate: ApprovalSnapshot };

export type ApprovalRequestResult =
  | { kind: "accepted" | "rejected"; candidate: ApprovalSnapshot }
  | { kind: "re-evaluate"; candidate: ApprovalSnapshot }
  | { kind: "missing" | "stale" | "busy" };

interface PendingApproval {
  snapshot: ApprovalSnapshot;
  promise: Promise<ApprovalDecision>;
  resolve: (decision: ApprovalDecision) => void;
}

const keyFor = (sessionID: string, messageID: string): string =>
  `${sessionID}\u0000${messageID}`;

/** In-process authority for manual prompt decisions. The JSONL file is transport only. */
export class ApprovalGateRegistry {
  private pending = new Map<string, PendingApproval>();

  open(
    sessionID: string,
    messageID: string,
    candidate: ApprovalCandidate,
  ): ApprovalSnapshot {
    const key = keyFor(sessionID, messageID);
    const current = this.pending.get(key);
    if (current) return current.snapshot;
    let resolve!: (decision: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((done) => {
      resolve = done;
    });
    const snapshot: ApprovalSnapshot = {
      sessionID,
      messageID,
      gateID: randomUUID(),
      revision: 1,
      phase: "awaiting-decision",
      ...candidate,
    };
    this.pending.set(key, { snapshot, promise, resolve });
    return snapshot;
  }

  owns(request: PromptEditorRequest): boolean {
    const current = this.pending.get(
      keyFor(request.sessionID, request.messageID),
    );
    return Boolean(
      current &&
      current.snapshot.gateID === request.gateID &&
      current.snapshot.revision === request.revision &&
      current.snapshot.phase === "awaiting-decision",
    );
  }

  get(sessionID: string, messageID: string): ApprovalSnapshot | undefined {
    return this.pending.get(keyFor(sessionID, messageID))?.snapshot;
  }

  wait(sessionID: string, messageID: string): Promise<ApprovalDecision> | null {
    return this.pending.get(keyFor(sessionID, messageID))?.promise ?? null;
  }

  request(request: PromptEditorRequest): ApprovalRequestResult {
    const pending = this.pending.get(
      keyFor(request.sessionID, request.messageID),
    );
    if (!pending) return { kind: "missing" };
    const snapshot = pending.snapshot;
    if (
      request.gateID !== snapshot.gateID ||
      request.revision !== snapshot.revision
    )
      return { kind: "stale" };
    if (snapshot.phase !== "awaiting-decision") return { kind: "busy" };

    if (request.kind === "re-evaluate") {
      const next = {
        ...snapshot,
        revision: snapshot.revision + 1,
        phase: "re-evaluating" as const,
      };
      pending.snapshot = next;
      return { kind: "re-evaluate", candidate: next };
    }

    if (request.kind !== "accept" && request.kind !== "reject")
      return { kind: "stale" };
    if (request.kind === "accept" && !snapshot.rewritten)
      return { kind: "busy" };

    const phase = request.kind === "accept" ? "accepted" : "rejected";
    const terminal = { ...snapshot, phase } as ApprovalSnapshot;
    pending.snapshot = terminal;
    pending.resolve({ kind: request.kind, candidate: terminal });
    return { kind: phase, candidate: terminal };
  }

  finishReevaluation(
    sessionID: string,
    messageID: string,
    revision: number,
    candidate: ApprovalCandidate,
  ): ApprovalSnapshot | null {
    const pending = this.pending.get(keyFor(sessionID, messageID));
    if (
      !pending ||
      pending.snapshot.phase !== "re-evaluating" ||
      pending.snapshot.revision !== revision
    )
      return null;
    const next: ApprovalSnapshot = {
      sessionID,
      messageID,
      gateID: pending.snapshot.gateID,
      revision,
      phase: "awaiting-decision",
      ...candidate,
    };
    pending.snapshot = next;
    return next;
  }

  cancel(sessionID: string, messageID: string): boolean {
    const pending = this.pending.get(keyFor(sessionID, messageID));
    if (!pending) return false;
    if (
      pending.snapshot.phase === "accepted" ||
      pending.snapshot.phase === "rejected"
    )
      return false;
    const cancelled = {
      ...pending.snapshot,
      phase: "cancelled" as const,
    };
    pending.snapshot = cancelled;
    pending.resolve({ kind: "cancel", candidate: cancelled });
    return true;
  }

  cancelSession(sessionID: string): void {
    for (const pending of this.pending.values()) {
      if (pending.snapshot.sessionID === sessionID)
        this.cancel(sessionID, pending.snapshot.messageID);
    }
  }

  close(sessionID: string, messageID: string): void {
    this.pending.delete(keyFor(sessionID, messageID));
  }

  cancelAll(): void {
    for (const candidate of this.pending.values())
      this.cancel(candidate.snapshot.sessionID, candidate.snapshot.messageID);
  }

  activeCount(): number {
    return this.pending.size;
  }
}
