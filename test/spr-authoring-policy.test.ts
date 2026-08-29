import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

const rootConfigText = readFileSync("spr-agent.jsonc", "utf8");
const distConfigText = readFileSync("dist/spr-agent.jsonc", "utf8");
const config = parse(rootConfigText) as {
  description?: string;
  system?: string;
  permissions?: Array<{ action?: string; resource?: string; effect?: string }>;
};

describe("SPR skill-authoring contract", () => {
  test("root and packaged agent definitions stay byte-identical", () => {
    expect(distConfigText).toBe(rootConfigText);
  });

  test("encodes deterministic decision, scope, conflict, and evaluation gates", () => {
    const system = config.system ?? "";
    for (const marker of [
      "create, update, no-op, or reject",
      "list managed skills in both available scopes",
      "project scope",
      "global scope",
      "shadow",
      "should-trigger",
      "should-not-trigger",
      "prior version or no-skill baseline",
      "forceReview means inspect; it never means save",
      "list -> view -> decide -> manage the minimal candidate -> re-view manager-visible state -> finalize",
    ]) {
      expect(system).toContain(marker);
    }
  });

  test("names only the lifecycle tools exposed by the wrapper", () => {
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
    for (const heading of [
      "## 5. Deterministic decision model",
      "## 6. Global versus project scope",
      "## 7. Skill artifact contract",
      "## 9. Evaluation contract",
      "## 10. Lifecycle protocol",
      "## 12. Definition of done",
    ]) {
      expect(handbook).toContain(heading);
    }
  });
});
