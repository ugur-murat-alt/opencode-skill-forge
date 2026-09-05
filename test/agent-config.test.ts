import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

describe("legacy hidden-agent defaults", () => {
  for (const file of [
    "spr-agent.jsonc",
    "prompt-editor-agent.jsonc",
    "test/fixtures/legacy/spr-agent.jsonc",
    "test/fixtures/legacy/prompt-editor-agent.jsonc",
  ]) {
    test(`${file} inherits OpenCode model resolution`, () => {
      const config = parse(readFileSync(file, "utf8")) as {
        model?: unknown;
      };
      expect(config.model).toBeNull();
    });
  }
});
