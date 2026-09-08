import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  decideEvolution,
  publicationDenial,
  type EvolutionEvidence,
  type PublicationGate,
} from "../src/domain/evolution-policy.js";
const evidence: EvolutionEvidence = {
  verified: true,
  reusable: true,
  materialChange: true,
  scopeResolved: true,
  canonicalOwner: "none",
  managed: true,
  protected: false,
  pinned: false,
};
const gate: PublicationGate = {
  candidateHash: "sha256:a",
  validationHash: "sha256:a",
  validationPassed: true,
  hasScripts: true,
  testHash: "sha256:a",
  testsPassed: true,
  sandboxAvailable: true,
  authorized: true,
  expectedRevision: "old",
  activeRevision: "old",
  workerFence: 2,
  currentFence: 2,
};
describe("MCP evolution policy", () => {
  test("verified reusable evidence selects one deterministic decision", () => {
    expect(decideEvolution(evidence).decision).toBe("create");
    expect(
      decideEvolution({ ...evidence, canonicalOwner: "read" }).decision,
    ).toBe("update");
    expect(
      decideEvolution({ ...evidence, materialChange: false }).decision,
    ).toBe("no-op");
    for (const change of [
      { verified: false },
      { scopeResolved: false },
      { canonicalOwner: "unread" as const },
      { canonicalOwner: "ambiguous" as const },
      { protected: true },
      { pinned: true },
      { managed: false },
    ])
      expect(decideEvolution({ ...evidence, ...change }).decision).toBe(
        "reject",
      );
  });
  test("script candidates require actual matching validation and isolated tests", () => {
    expect(publicationDenial(gate)).toBeNull();
    expect(publicationDenial({ ...gate, testHash: "old" })).toBe(
      "candidate_tests_required",
    );
    expect(publicationDenial({ ...gate, testsPassed: false })).toBe(
      "candidate_tests_required",
    );
    expect(publicationDenial({ ...gate, sandboxAvailable: false })).toBe(
      "sandbox_unavailable",
    );
    expect(publicationDenial({ ...gate, validationHash: "old" })).toBe(
      "candidate_validation_required",
    );
    expect(
      publicationDenial({
        ...gate,
        hasScripts: false,
        testsPassed: false,
        sandboxAvailable: false,
      }),
    ).toBeNull();
  });
  test("revocation and concurrent writers cannot publish stale candidates", () => {
    expect(publicationDenial({ ...gate, authorized: false })).toBe(
      "permission_revoked",
    );
    expect(publicationDenial({ ...gate, currentFence: 3 })).toBe(
      "stale_worker",
    );
    expect(publicationDenial({ ...gate, activeRevision: "new" })).toBe(
      "revision_conflict",
    );
  });
  test("legacy characterization bytes remain pinned to the synchronization commit", () => {
    const manifest = JSON.parse(
      readFileSync("test/fixtures/legacy/manifest.json", "utf8"),
    );
    for (const file of Object.values(manifest.files) as {
      fixture: string;
      sha256: string;
    }[])
      expect(
        createHash("sha256").update(readFileSync(file.fixture)).digest("hex"),
      ).toBe(file.sha256);
  });
  test("skill profile separates authority from untrusted content", () => {
    const spr = readFileSync("prompts/skill-evolve.md", "utf8");
    expect(spr).toContain("create, update, no-op or reject");
    expect(spr).toContain("No host shell/filesystem");
    expect(spr).toContain("Claims are not test evidence");
  });
});
