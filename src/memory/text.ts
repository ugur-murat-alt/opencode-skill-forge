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

/**
 * Function words that carry no retrieval signal. Filtering them on both the
 * index and query side keeps irrelevant English/Turkish questions from
 * matching on "the/is/for" alone (abstention), while content terms and
 * morphology stay untouched.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "in",
  "is",
  "it",
  "its",
  "may",
  "might",
  "must",
  "no",
  "not",
  "of",
  "on",
  "or",
  "shall",
  "should",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "will",
  "with",
  "would",
  "yes",
  "ama",
  "bir",
  "bu",
  "cok",
  "çok",
  "da",
  "daha",
  "de",
  "en",
  "fakat",
  "gore",
  "göre",
  "hem",
  "her",
  "icin",
  "için",
  "ile",
  "ise",
  "kadar",
  "ki",
  "mi",
  "mu",
  "mı",
  "nasil",
  "nasıl",
  "ne",
  "neden",
  "nedir",
  "niçin",
  "niye",
  "olan",
  "olarak",
  "once",
  "önce",
  "su",
  "şu",
  "uzere",
  "üzere",
  "var",
  "ve",
  "veya",
  "ya",
  "yok",
]);

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
    if (STOPWORDS.has(raw)) continue;
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
