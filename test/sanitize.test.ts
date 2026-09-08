import { describe, expect, test } from "bun:test";
import {
  sanitizeUntrustedText,
  CONTEXT_TRUNCATION_MARKER,
} from "../src/telemetry/sanitize.js";

describe("sanitizeUntrustedText", () => {
  test("redacts private keys, bearers and known token formats", () => {
    expect(
      sanitizeUntrustedText(
        "key:\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
        4000,
      ),
    ).toContain("[redacted private key]");
    expect(
      sanitizeUntrustedText("call with Bearer abc.def-ghi_jkl header", 4000),
    ).toContain("Bearer [redacted]");
    expect(
      sanitizeUntrustedText("token ghp_12345678901234567890 done", 4000),
    ).toContain("[redacted token]");
    expect(sanitizeUntrustedText('password="s3cret hunter2"', 4000)).toContain(
      "password=[redacted]",
    );
  });

  test("truncates over-budget text with an explicit marker", () => {
    const out = sanitizeUntrustedText("x".repeat(5000), 4000);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
  });

  test("short clean text passes through unchanged", () => {
    expect(sanitizeUntrustedText("Preserve 3 units.", 4000)).toBe(
      "Preserve 3 units.",
    );
  });
});
