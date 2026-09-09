import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "web", "src");

function tsxFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
  };
  walk(WEB);
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'/\w])\/\/.*$/gm, "$1");
}

test("P25 web chrome has no hardcoded Turkish outside the dictionary", () => {
  const hits: string[] = [];
  for (const file of tsxFiles()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [n, line] of code.split("\n").entries()) {
      const m = line.match(/[ğüşöçıİ]/);
      if (m)
        hits.push(
          `${file.split("/").pop()}:${n + 1}:${line.trim().slice(0, 80)}`,
        );
    }
  }
  expect(hits).toEqual([]);
});

test("P25 stylesheet has no bare colors outside variables", () => {
  const css = readFileSync(join(WEB, "style.css"), "utf8");
  const noVars = css.replace(/var\([^()]*\)/g, "var()");
  const hits: string[] = [];
  const patterns: [RegExp, string][] = [
    [/#[0-9a-fA-F]{3,8}\b/g, "hex"],
    [/\brgba?\([^)]*\)/g, "rgb"],
    [/\bhsla?\([^)]*\)/g, "hsl"],
    [
      /(?<![\w-])(white|black|red|green|blue|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia|purple|yellow|orange|pink|cyan|magenta|gold|violet|brown|beige|ivory|khaki|coral|salmon|turquoise|indigo|lavender)(?![\w-])/gi,
      "named",
    ],
  ];
  for (const [line, n] of noVars
    .split("\n")
    .map((l, i) => [l, i + 1] as const)) {
    const clean = line.replace(/\/\*.*?\*\//g, "");
    // Custom property definitions are the single allowed place for raw colors.
    if (/^\s*--[a-zA-Z0-9-]+\s*:/.test(clean)) continue;
    for (const [re, kind] of patterns) {
      const m = clean.match(re);
      if (m) hits.push(`${n}:${kind}:${m[0]}`);
    }
  }
  expect(hits).toEqual([]);
});

function flatten(obj: unknown, prefix = "", out = new Map<string, string>()) {
  if (typeof obj === "string") {
    out.set(prefix, obj);
    return out;
  }
  if (obj && typeof obj === "object")
    for (const [k, v] of Object.entries(obj))
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function placeholders(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]!),
    ),
  ].sort();
}

function srcErrorCodes(): string[] {
  const { execSync } =
    require("node:child_process") as typeof import("node:child_process");
  const root = join(import.meta.dir, "..");
  const files = execSync(`grep -rl 'ForgeError' ${root}/src --include='*.ts'`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const codes = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/new ForgeError\(\s*"([a-z_0-9]+)"/g))
      codes.add(m[1]!);
  }
  return [...codes].sort();
}

test("P25 dictionaries cover every server error code in both locales", async () => {
  const { tr } = await import("../web/src/i18n/tr.js");
  const { en } = await import("../web/src/i18n/en.js");
  const trMap = flatten(tr);
  const enMap = flatten(en);
  expect(trMap.has("errors.unknown")).toBe(true);
  expect(enMap.has("errors.unknown")).toBe(true);
  const missing: string[] = [];
  for (const code of srcErrorCodes()) {
    if (!trMap.has(`errors.${code}`)) missing.push(`tr.errors.${code}`);
    if (!enMap.has(`errors.${code}`)) missing.push(`en.errors.${code}`);
  }
  expect(missing).toEqual([]);
  const phMismatch: string[] = [];
  for (const [key, tv] of trMap) {
    const ev = enMap.get(key);
    if (ev === undefined) {
      phMismatch.push(`missing en: ${key}`);
      continue;
    }
    const a = placeholders(tv).join(",");
    const b = placeholders(ev).join(",");
    if (a !== b) phMismatch.push(`${key}: {${a}} vs {${b}}`);
  }
  for (const key of enMap.keys())
    if (!trMap.has(key)) phMismatch.push(`missing tr: ${key}`);
  expect(phMismatch).toEqual([]);
});
