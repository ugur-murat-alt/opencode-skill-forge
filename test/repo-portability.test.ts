import { test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * Windows-invalid tracked path guard (issue #4).
 * Git refuses to check out paths containing characters that are illegal on
 * Windows, which blocks the whole Windows CI job before any step runs.
 * The scan covers tracked files only; the negative fixture is simply adding
 * such a file — this test must fail for it.
 */
function trackedFiles(): string[] {
  const out = execSync("git ls-files -z", {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

const WINDOWS_INVALID_CHARS = /["<>|?*:]/;
const RESERVED_DEVICE =
  /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const TRAILING_DOT_OR_SPACE = /[ .]$/;

test("tracked paths are Windows-checkout portable", () => {
  const offenders: string[] = [];
  for (const path of trackedFiles()) {
    const segments = path.split("/");
    for (const [i, segment] of segments.entries()) {
      if (WINDOWS_INVALID_CHARS.test(segment))
        offenders.push(`${path}: invalid character in '${segment}'`);
      if (i < segments.length - 1 && segment.length === 0)
        offenders.push(`${path}: empty segment`);
      if (i === segments.length - 1) {
        if (RESERVED_DEVICE.test(segment.toLowerCase()))
          offenders.push(`${path}: reserved device name`);
        if (TRAILING_DOT_OR_SPACE.test(segment))
          offenders.push(`${path}: trailing dot/space`);
      }
    }
    if (/[\u0000-\u001f]/.test(path)) offenders.push(`${path}: control character`);
  }
  expect(offenders).toEqual([]);
});
