import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LEARN_ENTRY_MAX_CHARS,
  appendLearning,
  loadLearnFile,
  learnPreview,
} from "../../src/prompt-editor/learn.js";

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pe-learn-"));
  file = join(dir, "learn.md");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("appendLearning", () => {
  test("appends entries and reads them back, newest last", () => {
    appendLearning(file, "Lesson A", 65_536);
    appendLearning(file, "Lesson B", 65_536);
    const entries = loadLearnFile(file);
    expect(entries.map((e) => e.text)).toEqual(["Lesson A", "Lesson B"]);
    expect(learnPreview(file)).toBe("Lesson B");
  });

  test("entries use the configurable character cap", () => {
    const maxChars = 40;
    const big = "x".repeat(maxChars + 200);
    appendLearning(file, big, 65_536, maxChars);
    const entries = loadLearnFile(file);
    expect(entries.at(-1)!.text.length).toBe(maxChars);
    expect(DEFAULT_LEARN_ENTRY_MAX_CHARS).toBe(5_000);
  });

  test("size cap trims the oldest entries", () => {
    const capFile = join(dir, "cap.md");
    // ~ (500+12) bytes per entry; a 1.2KB cap keeps ~2 entries.
    appendLearning(capFile, "entry-1", 1024);
    appendLearning(capFile, "entry-2", 1024);
    appendLearning(capFile, "entry-3", 1024);
    const raw = readFileSync(capFile, "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(1024 + 64);
    const entries = loadLearnFile(capFile);
    // Newest entry must always survive.
    expect(entries.some((e) => e.text === "entry-3")).toBe(true);
  });

  test("empty text is a no-op", () => {
    const before = loadLearnFile(file).length;
    appendLearning(file, "   ", 65_536);
    expect(loadLearnFile(file).length).toBe(before);
  });

  test("credentials are redacted before persistence and on load", () => {
    const secretFile = join(dir, "secrets.md");
    appendLearning(
      secretFile,
      "Authorization: Basic dXNlcjpwYXNz\nCookie: sid=private; other=value",
      65_536,
    );
    const raw = readFileSync(secretFile, "utf8");
    expect(raw).not.toContain("dXNlcjpwYXNz");
    expect(raw).not.toContain("sid=private");
    expect(loadLearnFile(secretFile).at(-1)?.text).toContain("[redacted]");
  });
});
