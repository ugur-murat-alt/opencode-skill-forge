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
 * Issue #34 (M01): the memory boundary is verified on resolved module paths,
 * not on literal substrings. This mirrors the scanner pattern of
 * `test/architecture-boundaries.test.ts` (kept local so each suite runs
 * independently): relative and aliased specifiers are resolved against the
 * real file tree and computed dynamic imports are rejected. `src/domain/
 * memory.ts` is a pure contract (no storage/application/jobs/skills/runner/
 * mcp/execution), and `src/memory/**` never reaches into skill/runner/MCP/
 * execution internals. A negative fixture proves the scanner catches the
 * bypasses it promises to catch.
 */
interface ModuleRoot {
  prefix: string;
  dir: string;
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
  /\bimport\s+(?:type\s+)?(?:[^"'()]*?\sfrom\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const COMPUTED_IMPORT = /(?<!\basync\s)\b(?:import|require)\s*\(\s*(?!["'])/g;
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS)
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  return out;
}
function resolveSpecifier(
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
  return null;
}
function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function collectImportViolations(options: {
  scanDir: string;
  forbiddenDirs: string[];
  moduleRoots?: ModuleRoot[];
}): string[] {
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

const PRODUCTION_ROOTS: ModuleRoot[] = [{ prefix: "src", dir: SRC }];
const forbiddenFor = (dirs: string[]) => dirs.map((dir) => join(SRC, dir));

test("#34 memory domain contract imports no storage/application/jobs/skills/runner/mcp/execution", () => {
  const violations = collectImportViolations({
    scanDir: join(SRC, "domain"),
    forbiddenDirs: forbiddenFor([
      "storage",
      "application",
      "jobs",
      "skills",
      "runner",
      "mcp",
      "execution",
    ]),
    moduleRoots: PRODUCTION_ROOTS,
  });
  // The whole domain layer stays pure; the new memory contract is included
  // because it lives in the same scanned directory.
  expect(violations).toEqual([]);
  expect(readFileSync(join(SRC, "domain/memory.ts"), "utf8")).toContain(
    "MEMORY_FORMAT_VERSION",
  );
});

test("#34 memory application module never imports skills/runner/mcp/execution/transport", () => {
  const violations = collectImportViolations({
    scanDir: join(SRC, "memory"),
    forbiddenDirs: forbiddenFor([
      "skills",
      "runner",
      "mcp",
      "execution",
      "http",
      "cli",
      "clients",
      "web",
    ]),
    moduleRoots: PRODUCTION_ROOTS,
  });
  expect(violations).toEqual([]);
  // Sanity: the module set actually scanned is non-empty.
  expect(moduleFiles(join(SRC, "memory")).length).toBeGreaterThanOrEqual(3);
});

test("#34 boundary scanner flags aliased/nested/computed memory bypasses, not clean imports", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-memory-boundary-"));
  const fixtureSrc = join(root, "src");
  const write = (path: string, content: string) => {
    const file = join(fixtureSrc, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write("skills/store.ts", "export const store = true;\n");
  write("runner/handler.ts", "export const handler = true;\n");
  write("mcp/tool.ts", "export const tool = true;\n");
  write("execution/docker.ts", "export const docker = true;\n");
  write(
    "memory/evil-direct.ts",
    'import { store } from "../skills/store.js";\n',
  );
  write(
    "memory/nested/evil-nested.ts",
    'import { handler } from "../../runner/handler.js";\n',
  );
  write("memory/evil-alias.ts", 'import { tool } from "src/mcp/tool.js";\n');
  write(
    "memory/evil-dynamic.ts",
    'const target = "../execution/docker.js";\nconst mod = await import(target);\n',
  );
  write(
    "memory/clean.ts",
    'import { ForgeError } from "../domain/errors.js";\nexport { ForgeError };\n',
  );
  write("domain/errors.ts", "export class ForgeError extends Error {}\n");
  const violations = collectImportViolations({
    scanDir: join(fixtureSrc, "memory"),
    forbiddenDirs: ["skills", "runner", "mcp", "execution"].map((dir) =>
      join(fixtureSrc, dir),
    ),
    moduleRoots: [{ prefix: "src", dir: fixtureSrc }],
  });
  const flagged = violations.map((entry) =>
    relative(fixtureSrc, entry.split(":")[0]!),
  );
  expect(new Set(flagged)).toEqual(
    new Set([
      "memory/evil-direct.ts",
      "memory/nested/evil-nested.ts",
      "memory/evil-alias.ts",
      "memory/evil-dynamic.ts",
    ]),
  );
  expect(flagged).not.toContain("memory/clean.ts");
});
