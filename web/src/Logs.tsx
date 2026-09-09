import { api, errorCode } from "./api";
import { useState } from "react";
import { Download } from "lucide-react";
import { useLang } from "./i18n/lang";
import { useResource, ErrorNotice, Refresh, Empty, date } from "./ui";
export function Logs({ project }: { project: string }) {
  const [kind, setKind] = useState(""),
    [exportError, setExportError] = useState(""),
    [exporting, setExporting] = useState(false),
    resource = useResource<{
      items: {
        id: string;
        kind: string;
        created_at: number;
        detail: unknown;
      }[];
    }>(
      `/api/logs?project_ref=${encodeURIComponent(project)}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`,
    );
  const { t, lang } = useLang();
  function download() {
    if (!resource.data) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              exported_at: new Date().toISOString(),
              observation_scope: "authorized user and project audit events",
              ...resource.data,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "skill-forge-events.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function support() {
    setExporting(true);
    setExportError("");
    try {
      const value = await api(
        `/api/reports/support?project_ref=${encodeURIComponent(project)}`,
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "skill-forge-support.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportError(errorCode(e));
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <h1>{t("logs.title")}</h1>
      <p className="subtitle">{t("logs.subtitle")}</p>
      <div className="toolbar">
        <label>
          {t("logs.kindLabel")}
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t("logs.all")}</option>
            {[
              "skill.published",
              "skill.configured",
              "settings.updated",
              "request.error",
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <Refresh run={resource.refresh} loading={resource.loading} />
        <button onClick={download} disabled={!resource.data}>
          <Download size={16} /> {t("logs.exportJson")}
        </button>
      </div>
      <p>{t("logs.supportNote")}</p>
      <button disabled={exporting} onClick={() => void support()}>
        <Download size={16} />
        {exporting ? t("logs.preparing") : t("logs.downloadSupport")}
      </button>
      <ErrorNotice message={exportError || resource.error} />
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>{t("logs.colTime")}</th>
              <th>{t("logs.colEvent")}</th>
              <th>{t("logs.colDetail")}</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.items.map((item) => (
              <tr key={item.id}>
                <td>{date(item.created_at, lang)}</td>
                <td>{item.kind}</td>
                <td>
                  <details>
                    <summary className="mono">{item.id.slice(0, 12)}</summary>
                    <pre>{JSON.stringify(item.detail, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {resource.data?.items.length === 0 && (
          <Empty title={t("logs.emptyFilter")} />
        )}
      </section>
    </>
  );
}
