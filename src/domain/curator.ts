import { z } from "zod";

/**
 * Issue #39 (M06) Faz A: the pure MemoryCurator vocabulary.
 *
 * No IO, database or provider import lives here. The mode ladder, the bounded
 * job payload, the extractor/policy versions and the deterministic claim
 * classification are shared by the queue, the handler, the HTTP region and the
 * tests so no caller re-implements the policy.
 */

export const MEMORY_CURATOR_MODES = [
  "off",
  "manual",
  "shadow",
  "proposal",
  "auto",
] as const;
export type MemoryCuratorMode = (typeof MEMORY_CURATOR_MODES)[number];

/** Higher rank = more automation. A narrower layer can only reduce it. */
export function curatorModeRank(mode: MemoryCuratorMode): number {
  return MEMORY_CURATOR_MODES.indexOf(mode);
}

/** The stricter (lower-rank) mode wins; mode transitions never delete data. */
export function narrowCuratorMode(
  a: MemoryCuratorMode,
  b: MemoryCuratorMode,
): MemoryCuratorMode {
  return curatorModeRank(a) <= curatorModeRank(b) ? a : b;
}

export const CURATOR_EXTRACTOR_VERSION = "m06-extractor-v1";
export const CURATOR_POLICY_VERSION = "m06-policy-v1";

export const curatorSourceRefSchema = z
  .object({
    source_id: z.string().min(1).max(200),
    /** Path relative to the registered source root; never a host path. */
    path: z.string().min(1).max(4000).optional(),
    section: z.string().min(1).max(200).optional(),
  })
  .strict();

export const memoryCuratePayloadSchema = z
  .object({
    space_id: z.string().min(1).max(200),
    /**
     * Separate task modes of the single profile: extraction (new notes),
     * merge (update an existing note with base_revision) and conflict review
     * (contradiction/correction claims that can only stay proposals).
     */
    task: z.enum(["extract", "merge", "conflict"]).default("extract"),
    /** Requested mode; the effective settings mode is the hard ceiling. */
    mode: z.enum(MEMORY_CURATOR_MODES).optional(),
    source_refs: z.array(curatorSourceRefSchema).min(1).max(20),
    note_refs: z.array(z.string().min(1).max(200)).max(20).optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();
export type MemoryCuratePayload = z.infer<typeof memoryCuratePayloadSchema>;

export const MEMORY_CURATOR_OPERATIONS = [
  "create",
  "update",
  "supersede",
  "link",
] as const;
export type MemoryCuratorOperation = (typeof MEMORY_CURATOR_OPERATIONS)[number];

/** Kinds an auto-write policy may ever allow; deletion is not an operation. */
export const CURATOR_AUTO_WRITE_KINDS = ["preference", "fact", "note"] as const;
export type CuratorAutoWriteKind = (typeof CURATOR_AUTO_WRITE_KINDS)[number];

export const CURATOR_CLAIM_CLASSES = [
  "user_declaration",
  "prediction",
  "correction",
  "contradiction",
  "plan",
  "completed_work",
  "verified_fact",
] as const;
export type CuratorClaimClass = (typeof CURATOR_CLAIM_CLASSES)[number];

export interface CuratorClaimEvidence {
  /** The source is the user's own explicit statement. */
  readonly userDeclared: boolean;
  /** A non-model source independently confirms the claim. */
  readonly externallyVerified: boolean;
  /** The candidate would rewrite existing human-authored text. */
  readonly rewritesHumanText: boolean;
  /** The candidate contradicts an accepted record. */
  readonly contradictsAccepted: boolean;
  /** The text describes intended future work. */
  readonly describesPlan: boolean;
  /** The text claims the work/tests are already complete. */
  readonly claimsCompletion: boolean;
}

export type CuratorRisk = "low" | "medium" | "high";

export interface CuratorClaimClassification {
  readonly claimClass: CuratorClaimClass;
  /** Base kind the candidate may use; the model proposal can differ but is
   * still validated against the operation/policy rules. */
  readonly suggestedKind: CuratorAutoWriteKind | "context" | "session";
  readonly verification: "declared" | "verified" | "proposed";
  readonly risk: CuratorRisk;
  /** Whether an auto-write policy is even allowed to consider this class. */
  readonly autoWriteEligible: boolean;
}

/**
 * Deterministic classification. Priority is deliberate: completion claims,
 * contradictions and rewrites of human text can never be auto-written even
 * when they look confident. A user's own preference declaration is declared
 * truth about the user, not an externally verified fact.
 */
export function classifyCuratorClaim(
  evidence: CuratorClaimEvidence,
): CuratorClaimClassification {
  if (evidence.claimsCompletion)
    return {
      claimClass: "completed_work",
      suggestedKind: "session",
      verification: "proposed",
      risk: "high",
      autoWriteEligible: false,
    };
  if (evidence.contradictsAccepted)
    return {
      claimClass: "contradiction",
      suggestedKind: "context",
      verification: "proposed",
      risk: "high",
      autoWriteEligible: false,
    };
  if (evidence.rewritesHumanText)
    return {
      claimClass: "correction",
      suggestedKind: "context",
      verification: "proposed",
      risk: "high",
      autoWriteEligible: false,
    };
  if (evidence.externallyVerified)
    return {
      claimClass: "verified_fact",
      suggestedKind: "fact",
      verification: "verified",
      risk: "medium",
      autoWriteEligible: false,
    };
  if (evidence.describesPlan)
    return {
      claimClass: "plan",
      suggestedKind: "context",
      verification: "proposed",
      risk: "medium",
      autoWriteEligible: false,
    };
  if (evidence.userDeclared)
    return {
      claimClass: "user_declaration",
      suggestedKind: "preference",
      verification: "declared",
      risk: "low",
      autoWriteEligible: true,
    };
  return {
    claimClass: "prediction",
    suggestedKind: "context",
    verification: "proposed",
    risk: "medium",
    autoWriteEligible: false,
  };
}

/** Independent, bounded whole-run limits (hard ceilings, not suggestions). */
export const CURATOR_HARD_LIMITS = Object.freeze({
  maxCalls: 3,
  maxProposals: 8,
  maxSourceBytes: 65536,
});
