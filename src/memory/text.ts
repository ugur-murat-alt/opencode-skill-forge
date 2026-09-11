/**
 * Issue #36 (M03): deterministic Turkish/English lexical normalization for the
 * derived index and search. No locale-dependent case mapping: `İ/I` are
 * mapped explicitly and combining marks are stripped, so "İÇİN", "için" and
 * "icin" collapse to the same terms on every backend.
 */

export const MEMORY_TERM_MIN = 2;
export const MEMORY_TERM_MAX = 64;
export const MEMORY_QUERY_TERM_LIMIT = 8;
export const MEMORY_TITLE_TERM_LIMIT = 40;
export const MEMORY_BODY_TERM_LIMIT = 4000;

export function normalizeMemoryText(value: string): string {
  return value
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i");
}

export function tokenizeMemoryText(
  value: string,
  limit = MEMORY_BODY_TERM_LIMIT,
): string[] {
  const terms: string[] = [];
  for (const raw of normalizeMemoryText(value).split(/[^a-z0-9]+/)) {
    if (raw.length < MEMORY_TERM_MIN || raw.length > MEMORY_TERM_MAX) continue;
    terms.push(raw);
    if (terms.length >= limit) break;
  }
  return terms;
}

/** Frequency map for one field, capped to keep index rows bounded. */
export function termFrequencies(
  value: string,
  limit = MEMORY_BODY_TERM_LIMIT,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenizeMemoryText(value, limit))
    counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}
