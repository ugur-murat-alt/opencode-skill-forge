import { useState } from "react";
import { api } from "./api";
import {
  useResource,
  ErrorNotice,
  Refresh,
  JobTable,
  Status,
  type Job,
} from "./ui";
export function Jobs({ project }: { project: string }) {
  const [state, setState] = useState(""),
    [cursor, setCursor] = useState(""),
    [selected, setSelected] = useState<Job | null>(null),
    [error, setError] = useState("");
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
      setError(String(error));
    }
  }
  return (
    <>
      <h1>İşler</h1>
      <p className="subtitle">
        Kalıcı kuyruk, denemeler ve doğrulanmış sonuçlar.
      </p>
      <div className="toolbar">
        <label>
          Durum
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
                {value || "Tümü"}
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
            İlk sayfa
          </button>
          <button
            disabled={!resource.data?.next_cursor}
            onClick={() => setCursor(resource.data!.next_cursor!)}
          >
            Sonraki
          </button>
        </div>
      </section>
      {selected && (
        <section className="panel">
          <div className="section-heading">
            <h2>İş ayrıntısı</h2>
            <Status value={selected.status} />
            <button onClick={() => setSelected(null)}>Kapat</button>
          </div>
          <p className="mono">{selected.run_id}</p>
          <AttemptHistory key={selected.run_id} id={selected.run_id} />
          <dl>
            <dt>Deneme</dt>
            <dd>{selected.attempt}</dd>
            <dt>Hata kodu</dt>
            <dd>{selected.error_code ?? "Yok"}</dd>
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
              İşi iptal et
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
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button disabled={busy} onClick={() => void read()}>
        Sonuç içeriğini oku
      </button>
      <ErrorNotice message={error} />
      {chunk && (
        <>
          <pre className="code-view">{chunk.content}</pre>
          <small>
            Toplam {chunk.total_bytes} byte; bu bölüm en fazla 24 KiB.
          </small>
          {chunk.next_cursor && (
            <button disabled={busy} onClick={() => void read(true)}>
              Sonraki bölüm
            </button>
          )}
        </>
      )}
    </div>
  );
}

function AttemptHistory({ id }: { id: string }) {
  const [after, setAfter] = useState(0);
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
    <section aria-label="Deneme geçmişi">
      <div className="section-heading">
        <h3>Deneme geçmişi</h3>
        <Refresh run={history.refresh} loading={history.loading} />
      </div>
      <ErrorNotice message={history.error} />
      {history.data && (
        <>
          <p>
            Güncel durum: <Status value={history.data.status} />
          </p>
          {history.data.items.length === 0 ? (
            <p>Bu sayfada kayıtlı deneme yok.</p>
          ) : (
            <ol>
              {history.data.items.map((attempt) => (
                <li key={attempt.fence}>
                  <strong>Deneme {attempt.fence}</strong> ·{" "}
                  {attempt.result === "lease_expired"
                    ? "İşçi bağlantısı kesildi; sahiplik süresi doldu"
                    : attempt.result === null
                      ? "Devam ediyor"
                      : attempt.result}
                  <p>
                    {new Date(attempt.started_at).toLocaleString("tr-TR")} →{" "}
                    {attempt.ended_at === null
                      ? "Henüz bitmedi"
                      : new Date(attempt.ended_at).toLocaleString("tr-TR")}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <div className="pagination">
            <button disabled={after === 0} onClick={() => setAfter(0)}>
              İlk denemeler
            </button>
            <button
              disabled={history.data.next === null}
              onClick={() => setAfter(history.data!.next!)}
            >
              Sonraki denemeler
            </button>
          </div>
        </>
      )}
    </section>
  );
}
