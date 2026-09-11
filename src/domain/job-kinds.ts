import { z } from "zod";

/**
 * Issue #34 (M01): a job target is an explicit, typed scope. Project jobs
 * keep their project requirement; memory jobs may target a user's personal
 * space or a tenant organization space without fabricating a project.
 */
export type JobScope =
  | { readonly type: "project"; readonly projectId: string }
  | { readonly type: "personal" }
  | { readonly type: "organization" };
export type RunScopeKind = JobScope["type"];

/**
 * Issue #32: one small, static, typed job-kind definition instead of
 * hardcoded string checks spread through the queue and worker. A kind owns
 * its payload contract; whether it is skill-owned (latest `role = 'skill'`
 * provider snapshot + effective `evolutionEnabled` gate) is a property of the
 * definition, so the common accept/scheduling path never special-cases a
 * literal kind. This is not a plugin engine: registries are composed at
 * construction time, no directory is scanned or loaded dynamically.
 */
export interface JobKindDefinition {
  readonly kind: string;
  /** Payload contract. `accept()` parses it before hashing or storing. */
  readonly payload: z.ZodType;
  /**
   * Skill-owned kinds receive the provider profile snapshot at accept time
   * and are refused when the effective `evolutionEnabled` is false. Other
   * kinds never read provider profiles and run regardless of the flag.
   */
  readonly skillProfile: boolean;
  /**
   * Issue #34: `"project"` (default) keeps the historical project-scope
   * requirement. `"memory"` kinds accept explicit personal/organization/
   * project scopes and are gated by the independent `memoryEnabled` setting
   * instead of the evolution flag. Undefined means `"project"`.
   */
  readonly scope?: "project" | "memory";
}
export type JobKindRegistry = Readonly<Record<string, JobKindDefinition>>;

export const skillEvolveJobKind = {
  kind: "skill_evolve",
  // Historical skill handoffs accept any bounded JSON object; the shape is
  // validated by the SPR/tool contract, not narrowed here.
  payload: z.record(z.string(), z.unknown()),
  skillProfile: true,
} as const satisfies JobKindDefinition;

/** Production kinds. Test/composition kinds extend this registry explicitly. */
export const defaultJobKinds = {
  skill_evolve: skillEvolveJobKind,
} as const satisfies JobKindRegistry;
export type DefaultJobKind = keyof typeof defaultJobKinds;
/** Persisted `runs.kind` is open text; the queue/worker APIs stay typed. */
export type JobKind = DefaultJobKind | (string & {});
