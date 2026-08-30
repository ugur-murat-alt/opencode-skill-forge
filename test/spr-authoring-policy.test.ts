import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

const rootConfigText = readFileSync("spr-agent.jsonc", "utf8");
const distConfigText = readFileSync("dist/spr-agent.jsonc", "utf8");
const config = parse(rootConfigText) as {
  description?: string;
  system?: string;
  permissions?: Array<{
    action?: string;
    resource?: string;
    effect?: string;
  }>;
};

describe("SPR skill-authoring contract", () => {
  test("root and packaged agent definitions stay byte-identical", () => {
    expect(distConfigText).toBe(rootConfigText);
  });

  test("encodes deterministic decision, scope, conflict, and evaluation gates", () => {
    const system = config.system ?? "";
    for (const marker of [
      "create, update, no-op, or reject",
      "manager-visible project/global inventory",
      "effective project-first entry",
      "does not enumerate compatible or explicit skill sources",
      "path-derived, exact, and case-sensitive",
      "primary model-facing activation signal",
      "project scope",
      "global scope",
      "Never knowingly create a shadow, silent duplicate, or disguised fork when manager-visible or handoff evidence identifies the collision",
      "should-trigger",
      "should-not-trigger",
      "prior version or no-skill baseline",
      "must not create, modify, or remove executable files under scripts/",
      "forceReview means inspect; it never means save",
      "list -> view -> decide -> manage the minimal candidate -> re-view manager-visible state -> finalize",
      "For no-op/reject, do not call manage; finalize with no-change",
    ]) {
      expect(system).toContain(marker);
    }
  });

  test("names only the lifecycle tools exposed by the preserved core", () => {
    const system = config.system ?? "";
    for (const tool of [
      "omni_skill_list",
      "omni_skill_view",
      "omni_skill_manage",
      "omni_skill_finalize",
    ]) {
      expect(system).toContain(tool);
    }
    expect(system).not.toContain("omni_skill_validate");
    expect(system).not.toContain("omni_skill_review");
    expect(system).not.toContain("omni_skill_recommend");
  });

  test("keeps the reviewer deny-first and skill-creator in-memory only", () => {
    expect(config.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "omni_skill_manage", resource: "*", effect: "allow" },
      { action: "omni_skill_list", resource: "*", effect: "allow" },
      { action: "omni_skill_view", resource: "*", effect: "allow" },
      { action: "omni_skill_finalize", resource: "*", effect: "allow" },
      { action: "skill", resource: "skill-creator", effect: "allow" },
    ]);
  });

  test("ships the maintainer handbook with the package", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      files?: string[];
    };
    expect(packageJson.files).toContain("SPR_SKILL_AUTHORING.md");

    const handbook = readFileSync("SPR_SKILL_AUTHORING.md", "utf8");
    for (const marker of [
      "## 5. Deterministic decision model",
      "## 6. Global versus project scope",
      "path-derived, exact, case-sensitive ID",
      "explicit `skills` config entries",
      "## 7. Skill artifact contract",
      "### 7.1 Identity and frontmatter",
      "`allowed-tools` is experimental",
      "Use this skill when",
      "## 9. Evaluation contract",
      "8–10 should-trigger",
      "8–10 should-not-trigger",
      "fixed train/validation split",
      "## 10. Lifecycle protocol",
      "finalize(mutation-complete)",
      "finalize(no-change)",
      "do not call `manage` or `re-view` after a `no-op` or `reject` decision",
      "## 12. Definition of done",
      "manager-visible and explicitly reported same-ID and semantic conflicts",
      "preserved core bundle's registered tool",
      "https://opencode.ai/v2/docs/skills",
      "https://opencode.ai/v2/docs/agents",
      "https://agentskills.io/skill-creation/evaluating-skills",
    ]) {
      expect(handbook).toContain(marker);
    }
    expect(handbook).not.toContain("https://opencode.ai/docs/");
    expect(handbook).not.toContain("https://agentskills.io/skill-evals");
  });
});
