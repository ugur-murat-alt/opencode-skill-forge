export interface ScoreInput {
  name: string;
  description: string;
  updatedAt: number;
  usage: number;
}

export interface ScoreResult {
  score: number;
  why: string[];
}

/** Field tiers: a name hit always outranks description-only evidence. */
const TIER = {
  nameExact: 1,
  nameFull: 0.85,
  namePartial: 0.65,
  descFull: 0.55,
  descPartial: 0.35,
  inventory: 0.5,
} as const;

function terms(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic lexical score in [0,1] (rounded to 3 decimals so cursors and
 * caches stay stable). Usage only nudges within a tier, up to a tie with the
 * next tier; the tier order itself never inverts.
 */
export function scoreSkill(query: string, skill: ScoreInput): ScoreResult {
  const q = terms(query);
  if (!q.length) return { score: TIER.inventory, why: ["inventory"] };
  const nameTerms = terms(skill.name);
  const descTerms = terms(skill.description);
  const nameHit = q.filter((t) => nameTerms.includes(t)).length;
  const descHit = q.filter(
    (t) => !nameTerms.includes(t) && descTerms.includes(t),
  ).length;
  const matched = nameHit + descHit;
  if (!matched) return { score: 0, why: [] };
  const why = [`coverage:${matched}/${q.length}`];
  let base: number;
  if (normalize(skill.name) === normalize(query)) {
    base = TIER.nameExact;
    why.unshift("name:exact");
  } else if (nameHit === q.length) {
    base = TIER.nameFull;
    why.unshift(`name:${nameHit}/${q.length}`);
  } else if (nameHit > 0) {
    base = TIER.namePartial;
    why.unshift(`name:${nameHit}/${q.length}`);
  } else if (descHit === q.length) {
    base = TIER.descFull;
    why.unshift(`description:${descHit}/${q.length}`);
  } else {
    base = TIER.descPartial;
    why.unshift(`description:${descHit}/${q.length}`);
  }
  let score = base;
  if (skill.usage > 0) {
    score += Math.min(0.1, 0.02 * Math.log10(1 + skill.usage));
    why.push(`usage:${skill.usage}`);
  }
  return { score: Math.min(1, Math.round(score * 1000) / 1000), why };
}

/** Scope priority for deterministic tie-breaks (project first). */
export function scopePriority(scopeKey: string): number {
  if (scopeKey.startsWith("project:")) return 4;
  if (scopeKey.startsWith("environment:")) return 3;
  if (scopeKey === "workspace") return 2;
  return 1;
}
