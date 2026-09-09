import { useState } from "react";
import { Archive, RotateCcw, Download, Trash2 } from "lucide-react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
import { useResource, ErrorNotice, Refresh, Empty, date } from "./ui";
type Item = {
  skill_id: string;
  name: string;
  scope: string;
  revision: string;
  updated_at: number;
  archived: boolean;
  protected: boolean;
  pinned: boolean;
  managed: boolean;
  reason: string;
  observations: Record<string, { count: number; last_seen: number }>;
};
type Report = {
  items: Item[];
  next: string | null;
  window: { since: number; until: number };
  external_usage: string;
};
type Result = {
  items: {
    skill_id: string;
    name?: string;
    revision_count?: number;
    status: string;
    error?: { message: string };
  }[];
  effect?: string;
};
export function Maintenance({ project }: { project: string }) {
  const { t, tp, lang } = useLang();
  const reasons: Record<string, string> = {
    archived: t("maintenance.reasonArchived"),
    new_skill_grace: t("maintenance.reasonNewGrace"),
    not_observed_in_search: t("maintenance.reasonNotObserved"),
    visible_not_loaded: t("maintenance.reasonVisibleNotLoaded"),
    loaded_outcome_unknown: t("maintenance.reasonLoadedUnknown"),
  };
  const [state, setState] = useState("all"),
    [days, setDays] = useState(30),
    [after, setAfter] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [pending, setPending] = useState<{
      request: unknown;
      preview: Result;
    } | null>(null),
    [result, setResult] = useState<Result | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [cleanupAfter, setCleanupAfter] = useState("");
  const cleanups = useResource<{
    items: { skill_id: string }[];
    next: string | null;
  }>(
    `/api/maintenance/deletions?project_ref=${encodeURIComponent(project)}&after=${encodeURIComponent(cleanupAfter)}`,
  );
  async function resume(skill_id: string) {
    setBusy(true);
    setError("");
    try {
      const item = await api<Result["items"][number]>(
        "/api/maintenance/deletions/resume",
        {
          method: "POST",
          body: JSON.stringify({ project_ref: project, skill_id }),
        },
      );
      setResult({ items: [item] });
      await cleanups.refresh();
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  const report = useResource<Report>(
    `/api/maintenance?project_ref=${encodeURIComponent(project)}&state=${state}&days=${days}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
  );
  async function preview(action: "archive" | "restore" | "delete") {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const request = {
        project_ref: project,
        operation_id: crypto.randomUUID(),
        action,
        items: report
          .data!.items.filter((i) => selected.includes(i.skill_id))
          .map(({ skill_id, revision, updated_at }) => ({
            skill_id,
            revision,
            updated_at,
          })),
      };
      setPending({
        request,
        preview: await api<Result>("/api/maintenance/preview", {
          method: "POST",
          body: JSON.stringify(request),
        }),
      });
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await api<Result>("/api/maintenance/apply", {
          method: "POST",
          body: JSON.stringify(pending.request),
        }),
      );
      setPending(null);
      setSelected([]);
      await report.refresh();
      await cleanups.refresh();
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setAfter("");
    setSelected([]);
    setPending(null);
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report.data, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "skill-forge-maintenance.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <h1>{t("maintenance.title")}</h1>
      <p className="subtitle">{t("maintenance.subtitle")}</p>
      <div className="toolbar">
        <label>
          {t("maintenance.windowLabel")}
          <select
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              reset();
            }}
          >
            <option value={7}>{t("maintenance.days", { n: 7 })}</option>
            <option value={30}>{t("maintenance.days", { n: 30 })}</option>
            <option value={90}>{t("maintenance.days", { n: 90 })}</option>
            <option value={365}>{t("maintenance.days", { n: 365 })}</option>
          </select>
        </label>
        <label>
          {t("maintenance.stateLabel")}
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              reset();
            }}
          >
            <option value="all">{t("maintenance.stateAll")}</option>
            <option value="active">{t("maintenance.stateActive")}</option>
            <option value="archived">{t("maintenance.stateArchived")}</option>
          </select>
        </label>
        <Refresh run={report.refresh} loading={report.loading} />
        <button onClick={download} disabled={!report.data}>
          <Download size={16} />
          {t("maintenance.downloadReport")}
        </button>
      </div>
      <ErrorNotice message={error || report.error} />
      <p className="notice">{t("maintenance.notice")}</p>
      <div className="toolbar">
        <span>{tp("maintenance.selected", selected.length)}</span>
        <button
          disabled={!selected.length || busy}
          onClick={() => void preview("archive")}
        >
          <Archive size={16} />
          {t("maintenance.previewArchive")}
        </button>
        <button
          disabled={!selected.length || busy}
          onClick={() => void preview("restore")}
        >
          <RotateCcw size={16} />
          {t("maintenance.previewRestore")}
        </button>
        <button
          disabled={!selected.length || busy}
          onClick={() => void preview("delete")}
        >
          <Trash2 size={16} /> {t("maintenance.previewDelete")}
        </button>
      </div>
      {pending && (
        <section className="panel">
          <h2>{t("maintenance.previewTitle")}</h2>
          <p>{pending.preview.effect}</p>
          <p>{t("maintenance.previewNote")}</p>
          <ResultList value={pending.preview} />
          <div className="toolbar">
            <button
              className="primary"
              disabled={
                busy ||
                !pending.preview.items.some((i) => i.status === "eligible")
              }
              onClick={() => void apply()}
            >
              {t("maintenance.applyAction")}
            </button>
            <button disabled={busy} onClick={() => setPending(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </section>
      )}
      {result && (
        <section className="panel" aria-live="polite">
          <h2>{t("maintenance.resultTitle")}</h2>
          <ResultList value={result} />
        </section>
      )}
      <section className="panel">
        <h2>{t("maintenance.cleanupTitle")}</h2>
        <p>{t("maintenance.cleanupDetail")}</p>
        <ErrorNotice message={cleanups.error} />
        <Refresh run={cleanups.refresh} loading={cleanups.loading} />
        {cleanups.data?.items.map((item) => (
          <div className="toolbar" key={item.skill_id}>
            <code>{item.skill_id}</code>
            <button disabled={busy} onClick={() => void resume(item.skill_id)}>
              {t("maintenance.resumeCleanup")}
            </button>
          </div>
        ))}
        {cleanups.data && !cleanups.data.items.length && (
          <p>{t("maintenance.cleanupEmpty")}</p>
        )}
        {cleanupAfter && (
          <button disabled={busy} onClick={() => setCleanupAfter("")}>
            {t("maintenance.firstPage")}
          </button>
        )}
        {cleanups.data?.next && (
          <button
            disabled={busy}
            onClick={() => setCleanupAfter(cleanups.data!.next!)}
          >
            {t("maintenance.nextCleanups")}
          </button>
        )}
      </section>
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>{t("common.select")}</th>
              <th>{t("maintenance.thPackage")}</th>
              <th>{t("maintenance.thObservation")}</th>
              <th>{t("maintenance.thVisibility")}</th>
              <th>{t("maintenance.thScript")}</th>
            </tr>
          </thead>
          <tbody>
            {report.data?.items.map((item) => (
              <tr key={item.skill_id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t("maintenance.selectAria", {
                      name: item.name,
                    })}
                    checked={selected.includes(item.skill_id)}
                    onChange={(e) => {
                      setPending(null);
                      setSelected(
                        e.target.checked
                          ? [...selected, item.skill_id]
                          : selected.filter((id) => id !== item.skill_id),
                      );
                    }}
                  />
                </td>
                <td>
                  <strong>{item.name}</strong>
                  <small className="block">
                    {item.scope.startsWith("project:")
                      ? t("maintenance.scopeProject")
                      : item.scope.startsWith("personal:")
                        ? t("maintenance.scopePersonal")
                        : t("maintenance.scopeWorkspace")}
                    {item.pinned ? t("maintenance.pinnedSuffix") : ""}
                    {item.protected ? t("maintenance.protectedSuffix") : ""}
                  </small>
                </td>
                <td>{reasons[item.reason] ?? item.reason}</td>
                <td>
                  {item.observations.search_impression?.count ?? 0} /{" "}
                  {item.observations.loaded?.count ?? 0}
                </td>
                <td>
                  {item.observations.entrypoint_executed?.count ?? 0} /{" "}
                  {item.observations.execution_failed?.count ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.data?.items.length === 0 && (
          <Empty
            title={t("maintenance.emptyTitle")}
            detail={t("maintenance.emptyDetail")}
          />
        )}
      </section>
      <Retention project={project} refresh={report.refresh} />
      <div className="toolbar">
        {after && <button onClick={reset}>{t("maintenance.firstPage")}</button>}
        {report.data?.next && (
          <button
            onClick={() => {
              setAfter(report.data!.next!);
              setSelected([]);
              setPending(null);
            }}
          >
            {t("maintenance.next50")}
          </button>
        )}
        {report.data && (
          <small>
            {date(report.data.window.since, lang)} –{" "}
            {date(report.data.window.until, lang)}
          </small>
        )}
      </div>
    </>
  );
}
function ResultList({ value }: { value: Result }) {
  const { t, tp } = useLang();
  return (
    <ul>
      {value.items.map((item) => (
        <li key={item.skill_id}>
          <code>{item.name ?? item.skill_id.slice(0, 8)}</code>
          {item.revision_count !== undefined
            ? tp("maintenance.revisionCount", item.revision_count)
            : ""}
          :{" "}
          {item.error?.message ??
            (item.status === "eligible"
              ? t("maintenance.statusEligible")
              : item.status === "completed"
                ? t("maintenance.statusCompleted")
                : item.status === "pending_cleanup"
                  ? t("maintenance.statusPendingCleanup")
                  : t("maintenance.statusBlocked"))}
        </li>
      ))}
    </ul>
  );
}

function Retention({
  project,
  refresh,
}: {
  project: string;
  refresh: () => Promise<void>;
}) {
  const { t } = useLang();
  const [result, setResult] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const settings = useResource<{ values: { retentionDays: number } }>(
    `/api/settings/effective?project_ref=${encodeURIComponent(project)}`,
  );
  async function clean() {
    setBusy(true);
    setError("");
    try {
      setResult(
        await api("/api/telemetry/retain", {
          method: "POST",
          body: JSON.stringify({ project_ref: project }),
        }),
      );
      await refresh();
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>{t("maintenance.retentionTitle")}</h2>
      <p>
        {t("maintenance.retentionIntro", {
          days: settings.data?.values.retentionDays ?? t("status.unknown"),
        })}
      </p>
      <p>{t("maintenance.retentionDetail")}</p>
      <button disabled={busy || !settings.data} onClick={() => void clean()}>
        {busy ? t("maintenance.cleaning") : t("maintenance.cleanNow")}
      </button>
      <ErrorNotice message={error || settings.error} />
      {result && (
        <p role="status">
          {t("maintenance.retentionResult", {
            runs: result.scrubbed_runs,
            lessons: result.deleted_lessons,
            observations: result.deleted_observations,
            events: result.deleted_events,
          })}
          {result.may_have_more ? ` ${t("maintenance.retentionMore")}` : ""}
        </p>
      )}
    </section>
  );
}
