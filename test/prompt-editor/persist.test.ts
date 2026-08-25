import { describe, expect, test } from "bun:test";
import { findTextPart } from "../../src/prompt-editor/persist.js";

describe("findTextPart", () => {
  const payload = [
    {
      info: { id: "message-1" },
      parts: [
        { id: "part-1", type: "text", text: "changed elsewhere" },
        { id: "part-2", type: "text", text: "original prompt" },
      ],
    },
  ];

  test("selects only an exact original text match", () => {
    expect(findTextPart(payload, "message-1", "original prompt")?.part.id).toBe(
      "part-2",
    );
  });

  test("never falls back to a different current text part", () => {
    expect(findTextPart(payload, "message-1", "stale original")).toBeNull();
  });
});
