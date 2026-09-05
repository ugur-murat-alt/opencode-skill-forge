import { api } from "./api";
import { useState } from "react";
import { Download } from "lucide-react";
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
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <h1>Log ve teşhis</h1>
      <p className="subtitle">
        Yetkili kapsamın son 100 olayı. Sırlar ve hassas alanlar redakte edilir.
      </p>
      <div className="toolbar">
        <label>
          Olay türü
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Tümü</option>
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
          <Download size={16} /> JSON dışa aktar
        </button>
      </div>
      <p>
        Destek paketi sürüm, işletim ortamı, izinli iş durumu ve sınırlı olay
        metadata'sını içerir. Özel prompt, dosya içeriği, credential ve cihaz
        dizini eklenmez.
      </p>
      <button disabled={exporting} onClick={() => void support()}>
        <Download size={16} />
        {exporting ? "Hazırlanıyor…" : "Redakte destek paketini indir"}
      </button>
      <ErrorNotice message={exportError || resource.error} />
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Zaman</th>
              <th>Olay</th>
              <th>Ayrıntı</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.items.map((item) => (
              <tr key={item.id}>
                <td>{date(item.created_at)}</td>
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
          <Empty title="Bu filtrede olay yok" />
        )}
      </section>
    </>
  );
}
