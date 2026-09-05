import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "../execution/docker.js";
import type { Identity } from "./identity.js";
import { CursorCodec } from "./cursor.js";
import { ForgeError, type errorEnvelope } from "../domain/errors.js";
export interface StoredExecution {
  format_version?: 2;
  execution_id: string;
  sandbox_execution_id?: string;
  status: "completed" | "failed";
  result?: unknown;
  result_bytes?: number;
  result_artifact_path?: string;
  elapsed_ms?: number;
  artifacts?: { path: string; bytes: number; reference?: string }[];
  error?: ReturnType<typeof errorEnvelope>["error"];
}
export async function storeExecutionResult(
  dataDir: string,
  id: string,
  executed: ExecutionResult,
): Promise<StoredExecution> {
  const bytes = Buffer.from(JSON.stringify(executed.result));
  const artifacts = [...executed.artifacts];
  let resultPath: string | undefined;
  if (bytes.length > 8192) {
    resultPath = `forge-result-${randomUUID()}.json`;
    const directory = join(
      dataDir,
      "execution",
      executed.execution_id,
      "artifacts",
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fd = await open(join(directory, resultPath), "wx", 0o600);
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    artifacts.unshift({ path: resultPath, bytes: bytes.length });
  }
  return {
    format_version: 2,
    execution_id: id,
    sandbox_execution_id: executed.execution_id,
    status: "completed",
    result: resultPath ? undefined : executed.result,
    result_bytes: bytes.length,
    result_artifact_path: resultPath,
    elapsed_ms: executed.elapsed_ms,
    artifacts,
  };
}
export function executionPage(
  codec: CursorCodec,
  actor: Identity,
  project: string,
  stored: StoredExecution,
  limit = 10,
  cursor?: string,
) {
  const binding = [
    actor.tenantId,
    actor.userId,
    project,
    "execution_artifacts",
    stored.execution_id,
    limit,
  ];
  const offset = cursor ? codec.decode<number>(cursor, binding) : 0;
  const artifacts = stored.artifacts ?? [];
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifacts.length)
    throw new ForgeError("invalid_cursor", "Artifact aralığı geçersiz.");
  const encodedResult =
    stored.result === undefined ? null : JSON.stringify(stored.result);
  const truncated =
    !!stored.result_artifact_path ||
    (encodedResult !== null && Buffer.byteLength(encodedResult) > 8192);
  const base = {
    execution_id: stored.execution_id,
    status: stored.status,
    result: truncated ? undefined : stored.result,
    result_bytes:
      stored.result_bytes ??
      (encodedResult === null ? undefined : Buffer.byteLength(encodedResult)),
    result_truncated: truncated,
    result_artifact_path: stored.result_artifact_path,
    result_content_available: stored.status === "completed",
    elapsed_ms: stored.elapsed_ms,
    error: stored.error,
    artifact_count: artifacts.length,
  };
  const page: { path: string; bytes: number; reference: string | undefined }[] =
    [];
  let used = Buffer.byteLength(JSON.stringify(base));
  for (const a of artifacts.slice(offset, offset + limit)) {
    const item = {
      path: a.path,
      bytes: a.bytes,
      reference: stored.sandbox_execution_id
        ? codec.encode(
            [actor.tenantId, actor.userId, "artifact", stored.execution_id],
            { execution: stored.sandbox_execution_id, path: a.path },
          )
        : a.reference,
    };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (page.length && used + size > 14000) break;
    page.push(item);
    used += size;
  }
  return {
    ...base,
    artifacts: page,
    next_cursor:
      offset + page.length < artifacts.length
        ? codec.encode(binding, offset + page.length)
        : null,
  };
}
/** UTF-8 boundaries are preserved. A byte cap is never advertised as a token count. */
export function byteChunk(bytes: Buffer, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
    throw new ForgeError("invalid_cursor", "Dosya aralığı geçersiz.");
  let end = Math.min(bytes.length, offset + 24576);
  const binary =
    !Buffer.from(bytes.toString("utf8")).equals(bytes) || bytes.includes(0);
  if (!binary && end < bytes.length)
    while (end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    encoding: binary ? "base64" : "utf8",
    content: bytes.subarray(offset, end).toString(binary ? "base64" : "utf8"),
    bytes: end - offset,
    total_bytes: bytes.length,
    next: end < bytes.length ? end : null,
  };
}
