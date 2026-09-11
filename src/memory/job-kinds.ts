import { z } from "zod";
import {
  defaultJobKinds,
  type JobKindDefinition,
  type JobKindRegistry,
} from "../domain/job-kinds.js";

/**
 * Issue #34 (M01): the first static memory job kinds. They are model-free
 * (`skillProfile: false`) and carry `scope: "memory"`, so the common accept
 * path accepts explicit personal/project/organization scopes and gates them
 * with the independent `memoryEnabled` flag instead of `evolutionEnabled`.
 * The static-payload contract is validated before hashing or storing.
 */

export const memoryIngestPayloadSchema = z
  .object({
    spaceId: z.string().min(1).max(200),
    sourceEventKey: z.string().min(1).max(200),
    sourceKind: z.string().min(1).max(40),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    observedAt: z.number().int().min(0).optional(),
  })
  .strict();

export const memoryReconcilePayloadSchema = z
  .object({
    spaceId: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const memoryIngestJobKind = {
  kind: "memory_ingest",
  payload: memoryIngestPayloadSchema,
  skillProfile: false,
  scope: "memory",
} as const satisfies JobKindDefinition;

export const memoryReconcileJobKind = {
  kind: "memory_reconcile",
  payload: memoryReconcilePayloadSchema,
  skillProfile: false,
  scope: "memory",
} as const satisfies JobKindDefinition;

export const memoryJobKinds = {
  memory_ingest: memoryIngestJobKind,
  memory_reconcile: memoryReconcileJobKind,
} as const satisfies JobKindRegistry;

/** Production registry: the skill kind plus the static memory kinds. */
export const productionJobKinds = {
  ...defaultJobKinds,
  ...memoryJobKinds,
} as const satisfies JobKindRegistry;
export type ProductionJobKind = keyof typeof productionJobKinds;
