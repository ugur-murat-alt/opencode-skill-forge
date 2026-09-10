import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..", "src");

/**
 * Issue #19: module boundaries are protected by an automated import rule,
 * not by folder conventions. Application/domain/skill/job modules must not
 * import transport adapters (http, mcp, clients); the domain layer imports
 * nothing above it.
 */
function moduleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...moduleFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const APPLICATION_LAYERS = [
  "application",
  "skills",
  "jobs",
  "runner",
  "telemetry",
  "domain",
] as const;
const TRANSPORT_MARKERS = [
  '"../mcp/',
  "'../mcp/",
  '"./mcp/',
  '"../http/',
  "'../http/",
  '"./http/',
  '"../clients/',
  '"./clients/',
];

test("core layers never import transport adapters", () => {
  const offenders: string[] = [];
  for (const layer of APPLICATION_LAYERS) {
    for (const file of moduleFiles(join(SRC, layer))) {
      const source = readFileSync(file, "utf8");
      for (const marker of TRANSPORT_MARKERS)
        if (source.includes(marker))
          offenders.push(`${file}: imports ${marker.replace('"', "")}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("domain layer imports nothing above itself", () => {
  const offenders: string[] = [];
  for (const file of moduleFiles(join(SRC, "domain"))) {
    const source = readFileSync(file, "utf8");
    for (const marker of [
      '"../application/',
      '"../skills/',
      '"../http/',
      '"../mcp/',
      '"../jobs/',
      '"../runner/',
      '"../cli/',
    ])
      if (source.includes(marker))
        offenders.push(`${file}: imports ${marker.replace('"', "")}`);
  }
  expect(offenders).toEqual([]);
});

test("tool contracts live outside the MCP transport adapter", () => {
  const forge = readFileSync(join(SRC, "application/forge.ts"), "utf8");
  expect(forge).toContain("domain/tool-contracts.js");
  expect(forge).not.toContain("mcp/schemas");
});
