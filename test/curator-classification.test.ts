import { test, expect } from "bun:test";
import {
  classifyCuratorClaim,
  curatorModeRank,
  narrowCuratorMode,
} from "../src/domain/curator.js";

/**
 * Issue #39 acceptance: user declaration, prediction, correction,
 * contradiction, plan and completed work are distinct classes.
 */
test("claim fixtures map to the correct class, verification and risk", () => {
  const user = classifyCuratorClaim({
    userDeclared: true,
    externallyVerified: false,
    rewritesHumanText: false,
    contradictsAccepted: false,
    describesPlan: false,
    claimsCompletion: false,
  });
  expect(user.claimClass).toBe("user_declaration");
  expect(user.suggestedKind).toBe("preference");
  expect(user.verification).toBe("declared");
  expect(user.risk).toBe("low");
  expect(user.autoWriteEligible).toBe(true);

  const prediction = classifyCuratorClaim({
    userDeclared: false,
    externallyVerified: false,
    rewritesHumanText: false,
    contradictsAccepted: false,
    describesPlan: false,
    claimsCompletion: false,
  });
  expect(prediction.claimClass).toBe("prediction");
  expect(prediction.verification).toBe("proposed");
  expect(prediction.autoWriteEligible).toBe(false);

  const verified = classifyCuratorClaim({
    userDeclared: false,
    externallyVerified: true,
    rewritesHumanText: false,
    contradictsAccepted: false,
    describesPlan: false,
    claimsCompletion: false,
  });
  expect(verified.claimClass).toBe("verified_fact");
  expect(verified.verification).toBe("verified");
  expect(verified.risk).toBe("medium");
  expect(verified.autoWriteEligible).toBe(false);

  const correction = classifyCuratorClaim({
    userDeclared: true,
    externallyVerified: false,
    rewritesHumanText: true,
    contradictsAccepted: false,
    describesPlan: false,
    claimsCompletion: false,
  });
  expect(correction.claimClass).toBe("correction");
  expect(correction.risk).toBe("high");
  expect(correction.autoWriteEligible).toBe(false);

  const contradiction = classifyCuratorClaim({
    userDeclared: true,
    externallyVerified: false,
    rewritesHumanText: false,
    contradictsAccepted: true,
    describesPlan: false,
    claimsCompletion: false,
  });
  expect(contradiction.claimClass).toBe("contradiction");
  expect(contradiction.risk).toBe("high");

  const plan = classifyCuratorClaim({
    userDeclared: true,
    externallyVerified: false,
    rewritesHumanText: false,
    contradictsAccepted: false,
    describesPlan: true,
    claimsCompletion: false,
  });
  expect(plan.claimClass).toBe("plan");
  expect(plan.autoWriteEligible).toBe(false);

  const completed = classifyCuratorClaim({
    userDeclared: true,
    externallyVerified: true,
    rewritesHumanText: false,
    contradictsAccepted: false,
    describesPlan: false,
    claimsCompletion: true,
  });
  expect(completed.claimClass).toBe("completed_work");
  expect(completed.verification).toBe("proposed");
  expect(completed.autoWriteEligible).toBe(false);
});

test("mode ladder narrows privilege, never widens it", () => {
  expect(curatorModeRank("off")).toBeLessThan(curatorModeRank("manual"));
  expect(curatorModeRank("auto")).toBe(curatorModeRank("auto"));
  expect(narrowCuratorMode("auto", "manual")).toBe("manual");
  expect(narrowCuratorMode("proposal", "shadow")).toBe("shadow");
  expect(narrowCuratorMode("off", "auto")).toBe("off");
  expect(narrowCuratorMode("manual", "auto")).toBe("manual");
});
