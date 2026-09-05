/** Deterministic publication gates; model assertions never count as test evidence. */
export type EvolutionDecision = "create" | "update" | "no-op" | "reject";
export interface EvolutionEvidence {
  verified: boolean;
  reusable: boolean;
  materialChange: boolean;
  scopeResolved: boolean;
  canonicalOwner: "none" | "read" | "unread" | "ambiguous";
  managed: boolean;
  protected: boolean;
  pinned: boolean;
}
export function decideEvolution(evidence: EvolutionEvidence): {
  decision: EvolutionDecision;
  reason: string;
} {
  if (!evidence.scopeResolved || evidence.canonicalOwner === "ambiguous")
    return { decision: "reject", reason: "scope_or_owner_unresolved" };
  if (evidence.protected || evidence.pinned || !evidence.managed)
    return { decision: "reject", reason: "management_denied" };
  if (!evidence.verified)
    return { decision: "reject", reason: "evidence_unverified" };
  if (!evidence.reusable || !evidence.materialChange)
    return { decision: "no-op", reason: "no_durable_improvement" };
  if (evidence.canonicalOwner === "unread")
    return { decision: "reject", reason: "read_before_change_required" };
  return {
    decision: evidence.canonicalOwner === "none" ? "create" : "update",
    reason: "eligible_candidate",
  };
}
export interface PublicationGate {
  candidateHash: string;
  validationHash: string;
  validationPassed: boolean;
  hasScripts: boolean;
  testHash?: string;
  testsPassed?: boolean;
  sandboxAvailable?: boolean;
  authorized: boolean;
  expectedRevision: string | null;
  activeRevision: string | null;
  workerFence: number;
  currentFence: number;
}
export function publicationDenial(gate: PublicationGate): string | null {
  if (!gate.authorized) return "permission_revoked";
  if (gate.workerFence !== gate.currentFence) return "stale_worker";
  if (gate.expectedRevision !== gate.activeRevision) return "revision_conflict";
  if (
    !gate.candidateHash ||
    !gate.validationPassed ||
    gate.validationHash !== gate.candidateHash
  )
    return "candidate_validation_required";
  if (gate.hasScripts) {
    if (!gate.sandboxAvailable) return "sandbox_unavailable";
    if (!gate.testsPassed || gate.testHash !== gate.candidateHash)
      return "candidate_tests_required";
  }
  return null;
}
