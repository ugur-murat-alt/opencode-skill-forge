import { z } from "zod";
import {
  MEMORY_KINDS,
  MEMORY_LIFECYCLES,
  MEMORY_RELATIONS,
  TASK_STATUSES,
} from "../domain/memory.js";

/**
 * Issue #36 (M03): fixed input contracts for the six focused memory tools.
 * Identity/tenant/project are never part of the payload; the session identity
 * is resolved by the transport. Cursors are opaque and bound to the query and
 * scope by the search service.
 */

export const memoryToolSchemas = {
  memory_context: z
    .object({
      space_id: z.string().min(1).max(200).optional(),
      space_ids: z.array(z.string().min(1).max(200)).max(20).optional(),
      goal: z.string().min(1).max(2000).optional(),
      known_revisions: z
        .array(
          z
            .object({
              note_id: z.string().min(1).max(200),
              revision: z.number().int().min(1),
            })
            .strict(),
        )
        .max(200)
        .optional(),
      session_key: z.string().min(1).max(200).optional(),
      generation: z.number().int().min(0).optional(),
      branch: z.string().min(1).max(200).optional(),
      worktree: z.string().min(1).max(500).optional(),
      max_tokens: z.number().int().min(128).max(8192).optional(),
    })
    .strict(),
  memory_recall: z
    .object({
      query: z.string().min(1).max(200),
      space_id: z.string().min(1).max(200).optional(),
      space_ids: z.array(z.string().min(1).max(200)).max(20).optional(),
      kinds: z.array(z.enum(MEMORY_KINDS)).max(9).optional(),
      graph_depth: z.number().int().min(0).max(2).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      cursor: z.string().max(2048).optional(),
      as_of: z.string().min(1).max(40).optional(),
    })
    .strict(),
  memory_read: z
    .object({
      space_id: z.string().min(1).max(200),
      note_id: z.string().min(1).max(200),
      revision: z.number().int().min(1).optional(),
      neighbors: z.number().int().min(0).max(10).optional(),
    })
    .strict(),
  memory_update: z
    .object({
      space_id: z.string().min(1).max(200),
      note_id: z.string().min(1).max(200).optional(),
      expected_revision: z.number().int().min(1).optional(),
      kind: z.enum(MEMORY_KINDS).optional(),
      title: z.string().min(1).max(500).optional(),
      summary: z.string().max(8000).optional(),
      body: z.string().max(49152).optional(),
      lifecycle: z.enum(MEMORY_LIFECYCLES).optional(),
      pinned: z.boolean().optional(),
      task_status: z.enum(TASK_STATUSES).optional(),
      verification: z.enum(["declared", "verified", "proposed"]).optional(),
      archive: z.boolean().optional(),
      restore: z.boolean().optional(),
      supersede_target: z.string().min(1).max(200).optional(),
      event_key: z.string().min(1).max(200).optional(),
    })
    .strict(),
  memory_link: z
    .object({
      space_id: z.string().min(1).max(200),
      note_id: z.string().min(1).max(200),
      relation: z.enum(MEMORY_RELATIONS),
      target_note_id: z.string().min(1).max(200),
      remove: z.boolean().optional(),
      expected_revision: z.number().int().min(1),
      event_key: z.string().min(1).max(200).optional(),
    })
    .strict(),
  memory_checkpoint: z
    .object({
      space_id: z.string().min(1).max(200),
      note_id: z.string().min(1).max(200).optional(),
      expected_revision: z.number().int().min(1).optional(),
      goal: z.string().min(1).max(2000),
      progress: z.string().max(8000).optional(),
      blocker: z.string().max(4000).optional(),
      next_step: z.string().max(4000).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      event_key: z.string().min(1).max(200).optional(),
    })
    .strict(),
} as const;

export type MemoryToolName = keyof typeof memoryToolSchemas;

export const memoryToolDescriptions: Record<MemoryToolName, string> = {
  memory_context:
    "Compile a sourced, budgeted startup/delta context from the same authorized snapshot: active tasks, blockers, recent decisions, pins and a sourced continuation step. Returns note_id+revision per card; delivered revisions must be declared via known_revisions to get a delta. Text is a token estimate (bytes/2.5), never presented as exact tokenizer output.",
  memory_recall:
    "Search accepted memory revisions across authorized spaces. Global candidate discovery then bounded lexical scoring with Turkish/English normalization and a limited typed-graph expansion. Cards carry note_id, revision, kind, snippet, match reason and sources; stale index hits are excluded and reported.",
  memory_read:
    "Read one accepted revision (default: current head) with optional bounded neighbors from the derived typed graph. Unauthorized or deleted targets are omitted; content is returned verbatim from the immutable revision file.",
  memory_update:
    "Typed create/patch/archive/supersede/pin of a note revision with expected_revision CAS and a durable commit receipt. Partial success is never presented as atomic; a timeout returns queued with an event id instead of fake success.",
  memory_link:
    "Edit one typed relation on the source note's versioned metadata (add or remove). Both ends must be in the same authorized space; the edit commits a new source revision under its expected_revision CAS. There is no second graph writer.",
  memory_checkpoint:
    "Record a session checkpoint (goal/progress/blocker/next step) as a task note revision; it never marks a task done automatically and respects expected_revision when updating.",
};

/** Static schema publication only; validation stays per request. */
function publishedSchema(schema: z.ZodType) {
  const standard = schema["~standard"];
  const input = standard.jsonSchema.input({ target: "draft-2020-12" });
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input(options: Parameters<typeof standard.jsonSchema.input>[0]) {
          if (
            options.target === "draft-2020-12" &&
            Object.keys(options).length === 1
          )
            return structuredClone(input);
          return standard.jsonSchema.input(options);
        },
        output(options: Parameters<typeof standard.jsonSchema.output>[0]) {
          return standard.jsonSchema.output(options);
        },
      },
    },
  };
}

export const publishedMemoryToolSchemas = Object.fromEntries(
  Object.entries(memoryToolSchemas).map(([name, schema]) => [
    name,
    publishedSchema(schema),
  ]),
) as Record<MemoryToolName, ReturnType<typeof publishedSchema>>;
