/**
 * Issue #19: tool input/output contracts live in the contract layer, not in
 * the MCP transport adapter. `src/application` may import this file; it must
 * never import transport adapters (`src/mcp`, `src/http`).
 */
import { z } from "zod";
const ref = z.string().min(1).max(100),
  revision = z.string().regex(/^[a-f0-9]{64}$/),
  key = z.string().min(1).max(200);
export const toolSchemas = {
  forge_search: z
    .object({
      project_ref: ref,
      query: z.string().max(200).default(""),
      scope: z
        .enum(["personal", "project", "workspace", "environment"])
        .optional(),
      limit: z.number().int().min(1).max(20).default(5),
      cursor: z.string().max(3000).optional(),
    })
    .strict(),
  forge_load: z
    .object({
      project_ref: ref,
      skill_id: ref,
      revision,
      path: z.string().max(240).default("SKILL.md"),
      inventory: z.boolean().default(false),
      cursor: z.string().max(3000).optional(),
    })
    .strict(),
  forge_run: z
    .object({
      project_ref: ref,
      skill_id: ref,
      revision,
      entrypoint: z.string().max(64),
      args: z.record(z.string(), z.unknown()),
      idempotency_key: key,
    })
    .strict(),
  forge_handoff: z
    .object({
      project_ref: ref,
      summary: z.string().min(1).max(8000),
      idempotency_key: key,
      source: z
        .object({
          client: z.string().max(100),
          session: z.string().max(200).optional(),
        })
        .strict(),
      evidence: z
        .array(
          z
            .object({
              kind: z.enum(["test", "command", "observation"]),
              summary: z.string().max(2000),
              reference: z.string().max(500).optional(),
            })
            .strict(),
        )
        .max(12)
        .default([]),
    })
    .strict(),
  forge_report: z
    .object({
      project_ref: ref,
      run_id: ref.optional(),
      section: z.enum(["jobs", "maintenance", "execution"]).default("jobs"),
      execution_id: ref.optional(),
      artifact_reference: z.string().max(3000).optional(),
      result_content: z.boolean().default(false),
      observation_days: z.number().int().min(1).max(365).optional(),
      state: z.string().max(30).optional(),
      limit: z.number().int().min(1).max(20).default(10),
      cursor: z.string().max(3000).optional(),
    })
    .strict(),
};
export type ToolName = keyof typeof toolSchemas;
