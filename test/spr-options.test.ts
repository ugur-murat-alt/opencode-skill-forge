import { describe, expect, test } from "bun:test";
import { parseSprOptions } from "../src/spr-options.js";

describe("parseSprOptions", () => {
  test("parses provider/model with optional variant", () => {
    expect(
      parseSprOptions({
        spr: { model: "opencode/mimo-v2.5-free", variant: "think" },
      }),
    ).toEqual({ model: "opencode/mimo-v2.5-free", variant: "think" });
    expect(parseSprOptions({ spr: { model: "a/b" } })).toEqual({
      model: "a/b",
    });
    expect(
      parseSprOptions({
        spr: { allowedAgents: ["general", "plan", "build", "build", 42] },
      }),
    ).toEqual({ allowedAgents: ["general", "plan", "build"] });
  });

  test("ignores invalid or absent blocks instead of failing setup", () => {
    expect(parseSprOptions(undefined)).toBeUndefined();
    expect(parseSprOptions({})).toBeUndefined();
    expect(parseSprOptions({ spr: "x" })).toBeUndefined();
    expect(parseSprOptions({ spr: { model: "no-slash" } })).toBeUndefined();
    expect(parseSprOptions({ spr: { model: "/leading" } })).toBeUndefined();
    expect(parseSprOptions({ spr: { model: 42 } })).toBeUndefined();
    expect(parseSprOptions({ spr: { variant: "only" } })).toEqual({
      variant: "only",
    });
    expect(parseSprOptions({ spr: { allowedAgents: "build" } })).toEqual({
      allowedAgents: [],
    });
  });
});
