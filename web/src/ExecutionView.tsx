import { useState } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
import { ErrorNotice, Status } from "./ui";
type Artifact = { path: string; bytes: number; reference: string };
type Result = {
  execution_id: string;
  status: string;
  result?: unknown;
  result_truncated?: boolean;
  result_bytes?: number;
  artifacts?: Artifact[];
  artifact_count?: number;
  next_cursor?: string | null;
  elapsed_ms?: number;
  error?: { message: string };
};
export function ExecutionView({
  initial,
  project,
}: {
  initial: Result;
  project: string;
}) {
  const { t } = useLang();
  const [page, setPage] = useState(initial),
    [chunk, setChunk] = useState<{
      content: string;
      next_cursor: string | null;
      total_bytes: number;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function artifacts(first = false) {
    setBusy(true);
    setError("");
    try {
      setPage(
        await api<Result>("/api/tools/forge_report", {
          method: "POST",
          body: JSON.stringify({
            project_ref: project,
            section: "execution",
            execution_id: initial.execution_id,
            cursor: first ? undefined : page.next_cursor,
          }),
        }),
      );
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  async function result(next = false) {
    setBusy(true);
    setError("");
    try {
      setChunk(
        await api("/api/tools/forge_report", {
          method: "POST",
          body: JSON.stringify({
            project_ref: project,
            section: "execution",
            execution_id: initial.execution_id,
            result_content: true,
            cursor: next ? chunk?.next_cursor : undefined,
          }),
        }),
      );
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="execution-result">
      <div className="toolbar">
        <Status value={page.status} />
        <code>{initial.execution_id.slice(0, 12)}</code>
        {page.elapsed_ms !== undefined && (
          <span>{Math.round(page.elapsed_ms)} ms</span>
        )}
      </div>
      <ErrorNotice message={error} />
      {!error && page.error?.message && (
        <p role="alert" className="error">
          {page.error.message}
        </p>
      )}
      {page.result !== undefined && (
        <pre className="code-view">{JSON.stringify(page.result, null, 2)}</pre>
      )}
      {page.result_truncated && (
        <>
          <p>{t("exec.resultTruncated", { bytes: page.result_bytes ?? 0 })}</p>
          <button disabled={busy} onClick={() => void result()}>
            {t("exec.readFirst")}
          </button>
        </>
      )}
      {chunk && (
        <>
          <pre className="code-view">{chunk.content}</pre>
          <p>{t("exec.chunkNote", { total: chunk.total_bytes })}</p>
          {chunk.next_cursor && (
            <button disabled={busy} onClick={() => void result(true)}>
              {t("exec.readNext")}
            </button>
          )}
        </>
      )}
      {!!page.artifact_count && (
        <>
          <h3>
            {t("exec.artifactsTitle", { count: page.artifact_count ?? 0 })}
          </h3>
          <ul>
            {page.artifacts?.map((a) => (
              <li key={a.path}>
                <a
                  href={`/api/artifacts/${initial.execution_id}?reference=${encodeURIComponent(a.reference)}`}
                >
                  {t("exec.downloadFile", { path: a.path })}
                </a>{" "}
                <small>{t("exec.fileBytes", { bytes: a.bytes })}</small>
              </li>
            ))}
          </ul>
          <div className="toolbar">
            <button disabled={busy} onClick={() => void artifacts(true)}>
              {t("exec.refreshFirst")}
            </button>
            {page.next_cursor && (
              <button disabled={busy} onClick={() => void artifacts()}>
                {t("exec.nextArtifacts")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
