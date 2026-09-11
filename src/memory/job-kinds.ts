import { z } from "zod";
import {
  defaultJobKinds,
  type JobKindDefinition,
  type JobKindRegistry,
} from "../domain/job-kinds.js";
import { MEMORY_KINDS } from "../domain/memory.js";

/**
 * Issue #34 (M01): the first static memory job kinds. They are model-free
 * (`skillProfile: false`) and carry `scope: "memory"`, so the common accept
 * path accepts explicit personal/project/organization scopes and gates them
 * with the independent `memoryEnabled` flag instead of `evolutionEnabled`.
 * The static-payload contract is validated before hashing or storing.
 *
 * Issue #35 (M02): `memory_ingest` may carry bounded Markdown content; when
 * present, the handler runs the durable commit pipeline (revision + receipt).
 * `noteId`/`baseRevision` are the explicit edit identity/CAS inputs; payload
 * size stays inside the queue's 64 KiB envelope.
 */

/** Bounded content that fits the queue's 64 KiB payload envelope. */
export const MEMORY_INGEST_CONTENT_MAX = 48 * 1024;

export const memoryIngestPayloadSchema = z
  .object({
    spaceId: z.string().min(1).max(200),
    sourceEventKey: z.string().min(1).max(200),
    sourceKind: z.string().min(1).max(40),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    observedAt: z.number().int().min(0).optional(),
    /** M02: bounded Markdown to commit as an immutable revision. */
    content: z.string().min(1).max(MEMORY_INGEST_CONTENT_MAX).optional(),
    noteId: z.string().min(1).max(200).optional(),
    baseRevision: z.number().int().min(0).optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
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
