import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REWRITES_MAX_ENTRIES,
  appendRewrite,
  readRewrites,
} from "../legacy-runtime/prompt-editor/rewrites.js";
import type { RewriteRecord } from "../legacy-runtime/prompt-editor/rewrites.js";

function stub(over: Partial<RewriteRecord> = {}): RewriteRecord {
  return {
    ts: Date.now(),
    sessionID: "s1",
    messageID: "m1",
    outcome: "rewritten",
    original: "hello",
    rewritten: "hello there",
    model: "acme/fast",
    durationMs: 10,
    ...over,
  };
}

describe("rewrites", () => {
  test("appends and reads newest-first", () => {
    const dir = mkdtempSync(join(tmpdir(), "pe-rewrites-"));
    const file = join(dir, "rewrites.jsonl");
    try {
      appendRewrite(
        file,
        stub({ messageID: "a", original: "x", rewritten: "xx" }),
      );
      appendRewrite(
        file,
        stub({ messageID: "b", original: "y", rewritten: "yy" }),
      );
      const entries = readRewrites(file);
      expect(entries.map((e) => e.messageID)).toEqual(["b", "a"]);
      expect(entries[0]!.rewritten).toBe("yy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caps the file to the newest entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "pe-rewrites-cap-"));
    const file = join(dir, "rewrites.jsonl");
    try {
      for (let i = 0; i < REWRITES_MAX_ENTRIES + 25; i++) {
        appendRewrite(
          file,
          stub({
            messageID: `msg-${i}`,
            original: `o${i}`,
            rewritten: `r${i}`,
          }),
        );
      }
      const entries = readRewrites(file);
      expect(entries.length).toBe(REWRITES_MAX_ENTRIES);
      // The most recent survives.
      expect(entries[0]!.messageID).toBe(`msg-${REWRITES_MAX_ENTRIES + 24}`);
      // The oldest is trimmed.
      expect(entries.some((e) => e.messageID === "msg-0")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "pe-rewrites-bad-"));
    const file = join(dir, "rewrites.jsonl");
    try {
      writeFileSync(file, "{broken}\n", "utf8");
      appendRewrite(file, stub({ messageID: "ok" }));
      expect(readRewrites(file).map((e) => e.messageID)).toEqual(["ok"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an applied update replaces the pre-dispatch record for one message", () => {
    const dir = mkdtempSync(join(tmpdir(), "pe-rewrites-"));
    const file = join(dir, "rewrites.jsonl");
    try {
      appendRewrite(file, stub({ messageID: "same", applied: false }));
      appendRewrite(file, stub({ messageID: "same", applied: true }));
      expect(readRewrites(file)).toHaveLength(1);
      expect(readRewrites(file)[0]).toMatchObject({
        messageID: "same",
        applied: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
