import { type ToolName } from "../domain/tool-contracts.js";
export { toolSchemas, type ToolName } from "../domain/tool-contracts.js";
export const toolDescriptions: Record<ToolName, string> = {
  forge_search:
    "Search authorized skill metadata. Returns at most 5 default/20 max matches and an opaque cursor; no package content.",
  forge_load:
    "Read only a required file from a pinned revision, default SKILL.md. Text/base64 chunks at most 24 KiB; follow cursor for remainder. inventory=true pages all package file metadata without content.",
  forge_run:
    "Execute a registered JSON entrypoint at a pinned revision in an isolated sandbox. Use one stable idempotency key for retries. Results over 8 KiB become an artifact; lists are paginated through forge_report section=execution.",
  forge_handoff:
    "Durably accept a concise verified reusable experience before your final answer. No raw history or private reasoning. Accepted work continues independently.",
  forge_report:
    "Read concise authorized job status/results, section=maintenance for scoped observations, or section=execution with execution_id for paginated artifacts. Add artifact_reference or result_content=true to read 24 KiB chunks. Loading is not successful application. Filter by run_id, state or cursor; acceptance is not completion.",
};
