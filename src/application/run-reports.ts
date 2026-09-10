import { createHash } from "node:crypto";
import { byteChunk } from "./execution-results.js";
import { redact } from "../telemetry/redact.js";
import { ForgeError } from "../domain/errors.js";
import type { CursorCodec } from "./cursor.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Identity } from "./identity.js";
import type { Run } from "../storage/schema.js";
import type { z } from "zod";
import type { toolSchemas } from "../domain/tool-contracts.js";

/**
 * Issue #32 use-case pilot: the run report read model moved out of the
 * monolithic `ForgeService.invoke` switch. The HTTP `/api/runs` adapter and
 * the MCP `forge_report` dispatcher both call this one application function;
 * cursors, redaction and result chunking stay bound to the same request
 * identity, so behavior is unchanged.
 */
export type RunReportInput = z.infer<(typeof toolSchemas)["forge_report"]>;

export class RunReports {
  constructor(
    readonly queue: JobQueue,
    readonly cursors: CursorCodec,
  ) {}
  private publicRun(run: Run, detail = false) {
    const result = run.result_json ? JSON.parse(run.result_json) : null;
    const bytes = Buffer.byteLength(run.result_json ?? "null");
    return {
      run_id: run.id,
      kind: run.kind,
      status: run.state,
      created_at: run.created_at,
      updated_at: run.updated_at,
      attempt: run.attempt,
      error_code: run.error_code,
      result: detail && bytes <= 8192 ? result : undefined,
      result_available: run.result_json !== null,
      result_truncated: run.result_json !== null && (!detail || bytes > 8192),
      result_bytes: bytes,
      result_summary: result
        ? redact({
            decision:
              typeof result.decision === "string"
                ? result.decision.slice(0, 32)
                : undefined,
            reason:
              typeof result.reason === "string"
                ? result.reason.slice(0, 500)
                : undefined,
            usage: result.usage
              ? Object.fromEntries(
                  ["calls", "tokens", "cost_micros", "elapsed_ms"].map(
                    (key) => [
                      key,
                      typeof result.usage[key] === "number" &&
                      Number.isFinite(result.usage[key])
                        ? result.usage[key]
                        : null,
                    ],
                  ),
                )
              : null,
            content_expired: result.content_expired === true,
          })
        : null,
    };
  }
  async report(identity: Identity, value: RunReportInput) {
    const binding = [
      identity.tenantId,
      identity.userId,
      "forge_report",
      { ...value, cursor: undefined },
    ];
    if (value.run_id) {
      const run = await this.queue.get(identity, value.run_id);
      if (run.project_id !== value.project_ref)
        throw new ForgeError("project_mismatch", "İş başka projeye ait.", 403);
      if (value.result_content) {
        const resultBytes = Buffer.from(run.result_json ?? "null");
        const resultBinding = [
          ...binding,
          createHash("sha256").update(resultBytes).digest("hex"),
        ];
        const chunk = byteChunk(
          resultBytes,
          value.cursor
            ? this.cursors.decode<number>(value.cursor, resultBinding)
            : 0,
        );
        return {
          run_id: run.id,
          status: run.state,
          kind: "result_json",
          ...chunk,
          next: undefined,
          next_cursor:
            chunk.next !== null
              ? this.cursors.encode(resultBinding, chunk.next)
              : null,
        };
      }
      return this.publicRun(run, true);
    }
    if (value.result_content)
      throw new ForgeError(
        "invalid_filter",
        "İş sonucu içeriği için run_id gerekir.",
      );
    let query = this.queue.storage.db
      .selectFrom("runs")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .where("project_id", "=", value.project_ref);
    if (value.state)
      query = query.where("state", "=", value.state as Run["state"]);
    if (value.cursor)
      query = query.where(
        "id",
        ">",
        this.cursors.decode<string>(value.cursor, binding),
      );
    const rows = await query
      .orderBy("id")
      .limit(value.limit + 1)
      .execute();
    return {
      items: rows.slice(0, value.limit).map((row) => this.publicRun(row)),
      next_cursor:
        rows.length > value.limit
          ? this.cursors.encode(binding, rows[value.limit - 1]!.id)
          : null,
    };
  }
}
