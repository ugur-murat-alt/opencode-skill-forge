import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * P22 — Prompt Editor çıkarma sınırı (TDD kırmızı adım).
 *
 * Prompt alt sistemi üründen tamamen kalkar: `src/prompt/`, `forge_prepare`,
 * `prompt_edit` iş türü, `LearningStore`, prompt ayarları ve `/api/prompts/*`
 * uçları. Kalan referans, sessiz yarım kaldırma demektir.
 *
 * Kapsam dışı (bilerek taranmaz): `test/fixtures/legacy`,
 * `test/legacy-runtime` (karakterizasyon), `docs/evidence` (append-only geçmiş),
 * kök legacy agent JSONC dosyaları (legacy karakterizasyon testleri için durur),
 * `test/` geri kalanı (örn. `hook-session.test.ts` içindeki `forge_prepare`
 * referansı kasıtlı negatif guard'dır: eski ucun çağrılmadığını kanıtlar).
 * `learning_entries` tablosu bilerek yasaklı değildir: yazım yolu kalkar,
 * retention temizliği eski satırları yaşlandırır, migration geçmişi korunur.
 */
const ROOTS = ["src", "web/src", "scripts", "prompts", "docs/tr"];
const FILES = ["README.md", "SPR_SKILL_AUTHORING.md", "package.json"];
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".css",
]);
const FORBIDDEN = [
  "prompt_edit",
  "forge_prepare",
  "LearningStore",
  "prompt/learning",
  "prompt/guard",
  "prompt/sanitize",
  "sanitizePromptEditorText",
  "preservedConstraints",
  "skipPrompt",
  "promptEnabled",
  "promptMode",
  "autoApply",
  "prepare_mode",
  "visible_prompt_replacement",
  "/api/prompts",
  "LearningMigration",
  "migration-learning",
  "learning_not_reusable",
  "PromptEditor",
  "LessonEditor",
  "ImportedRewrites",
  "imported-rewrites",
  "SessionPreferences",
  "snapshot.values.learning",
  '=== "prompt"',
  '"prompt" | "skill"',
  "prompt-editor",
  "autoAccept",
  "session-flags",
];
// scripts/package-smoke.mjs, tarball'da legacy artifact bulunmadığını
// doğruladığı için legacy dosya adlarını anmak zorundadır.
const EXEMPT: Record<string, string[]> = {
  "scripts/package-smoke.mjs": ["prompt-editor"],
  // Drain migration'ı kaldırılmış türü adıyla kapatmak zorundadır.
  "src/storage/prompt-drain-migration.ts": ["prompt_edit"],
};
const ABSENT = [
  "src/prompt",
  "prompts/prompt-edit.md",
  "web/src/PromptEditor.tsx",
  "web/src/LessonEditor.tsx",
  "web/src/ImportedRewrites.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if ([...EXTENSIONS].some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

describe("P22 prompt removal boundary", () => {
  test("no prompt subsystem references in product sources", () => {
    const hits: string[] = [];
    const check = (file: string) => {
      const content = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (content.includes(pattern) && !EXEMPT[file]?.includes(pattern))
          hits.push(`${file} :: ${pattern}`);
      }
    };
    for (const root of ROOTS) {
      for (const file of walk(root)) check(file);
    }
    for (const file of FILES) check(file);
    expect(hits).toEqual([]);
  });

  test("prompt subsystem files are gone", () => {
    const remaining = ABSENT.filter((path) => existsSync(path));
    expect(remaining).toEqual([]);
  });
});
