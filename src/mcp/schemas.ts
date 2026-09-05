import { sessionSourceSchema } from "../application/session-preferences.js";
import { z } from "zod";
const ref = z.string().min(1).max(100),
  revision = z.string().regex(/^[a-f0-9]{64}$/),
  key = z.string().min(1).max(200);
export const toolSchemas = {
  forge_search: z
    .object({
      project_ref: ref,
      query: z.string().max(200).default(""),
      scope: z.enum(["personal", "project", "workspace"]).optional(),
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
  forge_prepare: z
    .object({
      project_ref: ref,
      original: z.string().min(1).max(32000),
      source: sessionSourceSchema.optional(),
      idempotency_key: key,
      wait_ms: z.number().int().min(0).max(15000).default(10000),
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
export const toolDescriptions: Record<ToolName, string> = {
  forge_search:
    "Search authorized skill metadata. Returns at most 5 default/20 max matches and an opaque cursor; no package content.",
  forge_load:
    "Read only a required file from a pinned revision, default SKILL.md. Text/base64 chunks at most 24 KiB; follow cursor for remainder. inventory=true pages all package file metadata without content.",
  forge_run:
    "Execute a registered JSON entrypoint at a pinned revision in an isolated sandbox. Use one stable idempotency key for retries. Results over 8 KiB become an artifact; lists are paginated through forge_report section=execution.",
  forge_prepare:
    "Prepare user text with preserved intent. Failure/timeout returns exact original. Never use for internal agent messages.",
  forge_handoff:
    "Durably accept a concise verified reusable experience before your final answer. No raw history or private reasoning. Accepted work continues independently.",
  forge_report:
    "Read concise authorized job status/results, section=maintenance for scoped observations, or section=execution with execution_id for paginated artifacts. Add artifact_reference or result_content=true to read 24 KiB chunks. Loading is not successful application. Filter by run_id, state or cursor; acceptance is not completion.",
};
