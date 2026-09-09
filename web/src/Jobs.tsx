import { useState } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
import {
  useResource,
  ErrorNotice,
  Refresh,
  JobTable,
  Status,
  date,
  type Job,
} from "./ui";
export function Jobs({ project }: { project: string }) {
  const [state, setState] = useState(""),
    [cursor, setCursor] = useState(""),
    [selected, setSelected] = useState<Job | null>(null),
    [error, setError] = useState("");
  const { t, st } = useLang();
  const resource = useResource<{ items: Job[]; next_cursor: string | null }>(
    `/api/runs?project_ref=${encodeURIComponent(project)}${state ? `&state=${state}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  async function cancel() {
    if (!selected) return;
    try {
      await api(`/api/runs/${selected.run_id}/cancel`, { method: "POST" });
      setSelected(null);
      await resource.refresh();
    } catch (error) {
      setError(errorCode(error));
    }
  }
  return (
    <>
      <h1>{t("jobs.title")}</h1>
      <p className="subtitle">{t("jobs.subtitle")}</p>
      <div className="toolbar">
        <label>
          {t("jobs.filterStatus")}
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setCursor("");
            }}
          >
            {[
              "",
              "queued",
              "running",
              "completed",
              "failed",
              "rejected",
              "fallback",
              "cancelled",
            ].map((value) => (
              <option key={value} value={value}>
                {value ? st(value) : t("jobs.all")}
              </option>
            ))}
          </select>
        </label>
        <Refresh run={resource.refresh} loading={resource.loading} />
      </div>
      <ErrorNotice message={resource.error || error} />
      <section className="panel table-panel">
        {resource.data && (
          <JobTable items={resource.data.items} select={setSelected} />
        )}
        <div className="pagination">
          <button disabled={!cursor} onClick={() => setCursor("")}>
            {t("jobs.firstPage")}
          </button>
          <button
            disabled={!resource.data?.next_cursor}
            onClick={() => setCursor(resource.data!.next_cursor!)}
          >
            {t("jobs.nextPage")}
          </button>
        </div>
      </section>
      {selected && (
        <section className="panel">
          <div className="section-heading">
            <h2>{t("jobs.detailTitle")}</h2>
            <Status value={selected.status} />
            <button onClick={() => setSelected(null)}>
              {t("common.close")}
            </button>
          </div>
          <p className="mono">{selected.run_id}</p>
          <AttemptHistory key={selected.run_id} id={selected.run_id} />
          <dl>
            <dt>{t("jobs.attempt")}</dt>
            <dd>{selected.attempt}</dd>
            <dt>{t("jobs.errorCode")}</dt>
            <dd>{selected.error_code ?? t("jobs.none")}</dd>
          </dl>
          {selected.result_summary != null && (
            <pre>{JSON.stringify(selected.result_summary, null, 2)}</pre>
          )}
          {selected.result_available && (
            <JobResult
              key={selected.run_id}
              project={project}
              id={selected.run_id}
            />
          )}
          {selected.result && (
            <pre className="code-view">
              {JSON.stringify(selected.result, null, 2)}
            </pre>
          )}
          {["queued", "running", "retry_wait"].includes(selected.status) && (
            <button className="danger" onClick={() => void cancel()}>
              {t("jobs.cancelJob")}
            </button>
          )}
        </section>
      )}
    </>
  );
}

function JobResult({ project, id }: { project: string; id: string }) {
  const [chunk, setChunk] = useState<{
      content: string;
      next_cursor: string | null;
      total_bytes: number;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const { t } = useLang();
  async function read(next = false) {
    setBusy(true);
    setError("");
    try {
      setChunk(
        await api("/api/tools/forge_report", {
          method: "POST",
          body: JSON.stringify({
            project_ref: project,
            run_id: id,
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
    <div>
      <button disabled={busy} onClick={() => void read()}>
        {t("jobs.readResult")}
      </button>
      <ErrorNotice message={error} />
      {chunk && (
        <>
          <pre className="code-view">{chunk.content}</pre>
          <small>{t("jobs.resultChunk", { bytes: chunk.total_bytes })}</small>
          {chunk.next_cursor && (
            <button disabled={busy} onClick={() => void read(true)}>
              {t("jobs.nextChunk")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function AttemptHistory({ id }: { id: string }) {
  const [after, setAfter] = useState(0);
  const { t, lang } = useLang();
  const history = useResource<{
    status: string;
    items: {
      fence: number;
      started_at: number;
      ended_at: number | null;
      result: string | null;
    }[];
    next: number | null;
  }>(`/api/runs/${encodeURIComponent(id)}/attempts?after=${after}`);
  return (
    <section aria-label={t("jobs.attemptHistory")}>
      <div className="section-heading">
        <h3>{t("jobs.attemptHistory")}</h3>
        <Refresh run={history.refresh} loading={history.loading} />
      </div>
      <ErrorNotice message={history.error} />
      {history.data && (
        <>
          <p>
            {t("jobs.currentStatus")} <Status value={history.data.status} />
          </p>
          {history.data.items.length === 0 ? (
            <p>{t("jobs.noAttempts")}</p>
          ) : (
            <ol>
              {history.data.items.map((attempt) => (
                <li key={attempt.fence}>
                  <strong>
                    {t("jobs.attemptN", { fence: attempt.fence })}
                  </strong>{" "}
                  ·{" "}
                  {attempt.result === "lease_expired"
                    ? t("jobs.leaseExpired")
                    : attempt.result === null
                      ? t("jobs.ongoing")
                      : attempt.result}
                  <p>
                    {date(attempt.started_at, lang)} →{" "}
                    {attempt.ended_at === null
                      ? t("jobs.notEnded")
                      : date(attempt.ended_at, lang)}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <div className="pagination">
            <button disabled={after === 0} onClick={() => setAfter(0)}>
              {t("jobs.firstAttempts")}
            </button>
            <button
              disabled={history.data.next === null}
              onClick={() => setAfter(history.data!.next!)}
            >
              {t("jobs.nextAttempts")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
