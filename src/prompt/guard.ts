/** Preserve mechanically detectable user constraints; rejection always returns original. */
export function preservedConstraints(
  original: string,
  candidate: string,
): boolean {
  if (
    !candidate.trim() ||
    candidate.length > Math.max(4096, original.length * 3)
  )
    return false;
  const literals: string[] =
    original.match(
      /`[^`]+`|(?:\b\d+(?:[.,:/-]\d+)*\b)|(?:\b(?:https?:\/\/|\.?\.?\/)[^\s]+)|\b(?:not|never|without|only|don't|sadece|yalnız|asla|değil|hariç|olmadan)\b/giu,
    ) ?? [];
  const words = original.match(/[\p{L}]+/gu) ?? [];
  literals.push(
    ...words.filter((word) =>
      /(?:ma|me|mayın|meyin|madan|meden|mamalı|memeli)$/iu.test(word),
    ),
  );
  literals.push(
    ...(original.match(
      /(?:[\w.-]+\/)+[\w.-]+|\bv\d+(?:\.\d+)+|\b\d+(?:[.,]\d+)?\s*(?:ms|saniye|dakika|saat|MB|GB|MiB|GiB|satır|adet|kez|%)/gu,
    ) ?? []),
  );
  const normalized = candidate.normalize("NFC").toLocaleLowerCase("tr-TR");
  return literals.every((literal) =>
    normalized.includes(literal.normalize("NFC").toLocaleLowerCase("tr-TR")),
  );
}
export function skipPrompt(original: string, mode: string): string | null {
  if (mode === "off") return "disabled";
  if (!original.trim() || /^\s*\//.test(original)) return "command_or_empty";
  if (original.trim().length < 12) return "continuation_context_required";
  return null;
}
