import { test, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..", "src");

/**
 * Issue #32: architecture boundaries are verified on resolved module paths,
 * not on a handful of literal import strings. The scanner resolves relative
 * specifiers, configured bare-specifier roots/aliases and rejects computed
 * dynamic imports inside core layers, so nested `../..`, alias and dynamic
 * import bypasses cannot slip through. `test/architecture-boundaries-*`
 * negative fixtures exercise each bypass against the same scanner.
 */
export interface ModuleRoot {
  prefix: string;
  dir: string;
}
export interface ImportScanOptions {
  /** Absolute directory whose `.ts` files are scanned recursively. */
  scanDir: string;
  /** Absolute directories a scanned file must never resolve into. */
  forbiddenDirs: string[];
  /** Bare-specifier prefixes (aliases / roots) with their resolved root. */
  moduleRoots?: ModuleRoot[];
}
function moduleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...moduleFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}
const SPECIFIER_PATTERNS: RegExp[] = [
  // import default, {named}, * as ns, type-only, or side-effect imports.
  /\bimport\s+(?:type\s+)?(?:[^"'()]*?\sfrom\s+)?["']([^"']+)["']/g,
  // export { a } from "..." and export * from "...".
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
  // static import("...") / require("...") calls.
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
];
/** `import(` / `require(` whose argument is not a string literal. */
const COMPUTED_IMPORT = /(?<!\basync\s)\b(?:import|require)\s*\(\s*(?!["'])/g;
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  moduleRoots: ModuleRoot[] = [],
): string | null {
  if (specifier.startsWith(".")) return resolve(dirname(fromFile), specifier);
  for (const root of moduleRoots) {
    if (specifier === root.prefix)
      return resolve(root.dir, specifier.slice(root.prefix.length));
    if (specifier.startsWith(`${root.prefix}/`))
      return resolve(root.dir, specifier.slice(root.prefix.length + 1));
  }
  return null; // Bare package specifier: not a local module boundary case.
}
export function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function collectImportViolations(options: ImportScanOptions): string[] {
  const { scanDir, forbiddenDirs, moduleRoots = [] } = options;
  const offenders: string[] = [];
  for (const file of moduleFiles(scanDir)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveSpecifier(file, specifier, moduleRoots);
      if (!resolved) continue;
      if (forbiddenDirs.some((dir) => isInside(dir, resolved)))
        offenders.push(`${file}: ${specifier} -> ${resolved}`);
    }
    for (const _computed of source.matchAll(COMPUTED_IMPORT))
      offenders.push(`${file}: computed dynamic import/require`);
  }
  return offenders;
}

const APPLICATION_LAYERS = [
  "application",
  "skills",
  "jobs",
  "runner",
  "telemetry",
  "domain",
] as const;
const TRANSPORT_DIRS = ["mcp", "http", "clients"].map((dir) => join(SRC, dir));
const PRODUCTION_ROOTS: ModuleRoot[] = [{ prefix: "src", dir: SRC }];

test("core layers never import transport adapters (resolved module paths)", () => {
  const offenders: string[] = [];
  for (const layer of APPLICATION_LAYERS)
    offenders.push(
      ...collectImportViolations({
        scanDir: join(SRC, layer),
        forbiddenDirs: TRANSPORT_DIRS,
        moduleRoots: PRODUCTION_ROOTS,
      }),
    );
  expect(offenders).toEqual([]);
});

test("domain layer imports nothing above itself (resolved module paths)", () => {
  const offenders = collectImportViolations({
    scanDir: join(SRC, "domain"),
    forbiddenDirs: [
      "application",
      "skills",
      "jobs",
      "runner",
      "cli",
      "mcp",
      "http",
      "clients",
    ].map((dir) => join(SRC, dir)),
    moduleRoots: PRODUCTION_ROOTS,
  });
  expect(offenders).toEqual([]);
});

test("tool contracts live outside the MCP transport adapter", () => {
  const forge = readFileSync(join(SRC, "application/forge.ts"), "utf8");
  expect(forge).toContain("domain/tool-contracts.js");
  expect(forge).not.toContain("mcp/schemas");
});

/**
 * Negative fixture: every bypass the old literal-substring check missed must
 * be flagged by the resolved-path scanner. The clean fixture proves that a
 * literal path inside a normal string is no longer a false positive.
 */
test("boundary scanner catches nested, alias, re-export and computed dynamic imports", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-boundary-"));
  const fixtureSrc = join(root, "src");
  const write = (path: string, content: string) => {
    const file = join(fixtureSrc, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write("http/server.ts", "export const http = true;\n");
  write("mcp/tool.ts", "export const tool = true;\n");
  write("clients/api.ts", "export const api = true;\n");
  write("jobs/evil-direct.ts", 'import { tool } from "../mcp/tool.js";\n');
  write(
    "jobs/nested/evil-nested.ts",
    'import { http } from "../../http/server.js";\n',
  );
  write("jobs/evil-alias.ts", 'import { tool } from "@/mcp/tool";\n');
  write("jobs/evil-reexport.ts", 'export { http } from "../http/server.js";\n');
  write("jobs/evil-src-prefix.ts", 'import { tool } from "src/mcp/tool.js";\n');
  write("jobs/evil-require.ts", 'const api = require("../clients/api.js");\n');
  write(
    "jobs/evil-computed-dynamic.ts",
    'const target = "../mcp/tool.js";\nconst mod = await import(target);\n',
  );
  write(
    "jobs/clean-literal.ts",
    "const hint = 'see \"../mcp/tool.js\" in the notes';\n",
  );
  write(
    "jobs/clean-domain.ts",
    'import { ForgeError } from "../../domain/errors.js";\nexport { ForgeError };\n',
  );
  write("domain/errors.ts", "export class ForgeError extends Error {}\n");
  const cleanLiteral = join(fixtureSrc, "jobs/clean-literal.ts");
  // The old check looked for these literal markers anywhere in the file.
  expect(readFileSync(cleanLiteral, "utf8")).toContain('"../mcp/');
  const offenders = collectImportViolations({
    scanDir: join(fixtureSrc, "jobs"),
    forbiddenDirs: ["mcp", "http", "clients"].map((dir) =>
      join(fixtureSrc, dir),
    ),
    moduleRoots: [
      { prefix: "@", dir: fixtureSrc },
      { prefix: "src", dir: fixtureSrc },
    ],
  });
  const flagged = offenders.map((entry) =>
    relative(fixtureSrc, entry.split(":")[0]!),
  );
  expect(new Set(flagged)).toEqual(
    new Set([
      "jobs/evil-direct.ts",
      "jobs/nested/evil-nested.ts",
      "jobs/evil-alias.ts",
      "jobs/evil-reexport.ts",
      "jobs/evil-src-prefix.ts",
      "jobs/evil-require.ts",
      "jobs/evil-computed-dynamic.ts",
    ]),
  );
  expect(flagged).not.toContain("jobs/clean-literal.ts");
  expect(flagged).not.toContain("jobs/clean-domain.ts");
});
