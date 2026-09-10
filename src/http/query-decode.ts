import type { FastifyRequest } from "fastify";

/**
 * Issue #10: GET query strings arrive untyped, while the MCP tool schemas are
 * strictly typed. Decode the known numeric/boolean fields explicitly at the
 * HTTP boundary instead of loosening the schemas. Everything else (including
 * non-numeric garbage for numeric fields) passes through untouched so the
 * typed schema rejects it with its own clear validation error.
 */
export function decodeQueryToolInput(
  query: FastifyRequest["query"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    if (key === "result_content" || key === "inventory") {
      if (value === "true") out[key] = true;
      else if (value === "false") out[key] = false;
      else out[key] = value;
    } else if (
      key === "limit" ||
      key === "observation_days" ||
      key === "after"
    ) {
      const n = Number(value);
      out[key] = value.trim() !== "" && Number.isFinite(n) ? n : value;
    } else out[key] = value;
  }
  return out;
}
