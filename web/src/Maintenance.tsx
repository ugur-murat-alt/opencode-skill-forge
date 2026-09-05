import { useState } from "react";
import { Archive, RotateCcw, Download, Trash2 } from "lucide-react";
import { api } from "./api";
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
const reasons: Record<string, string> = {
  archived: "Arşivde",
  new_skill_grace: "Yeni paket · 7 gün gözlem",
  not_observed_in_search: "Bu kapsamda aramada görünmedi",
  visible_not_loaded: "Göründü, yüklenmedi",
  loaded_outcome_unknown: "Yüklendi; görev sonucu bilinmiyor",
};
export function Maintenance({ project }: { project: string }) {
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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
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
      <h1>Bakım</h1>
      <p className="subtitle">
        Görünürlük ve kullanım farklı ölçülür. Yüklenen bir paket, başarılı
        uygulama anlamına gelmez.
      </p>
      <div className="toolbar">
        <label>
          Gözlem penceresi
          <select
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              reset();
            }}
          >
            <option value={7}>7 gün</option>
            <option value={30}>30 gün</option>
            <option value={90}>90 gün</option>
            <option value={365}>365 gün</option>
          </select>
        </label>
        <label>
          Paket durumu
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              reset();
            }}
          >
            <option value="all">Tümü</option>
            <option value="active">Aktif</option>
            <option value="archived">Arşivde</option>
          </select>
        </label>
        <Refresh run={report.refresh} loading={report.loading} />
        <button onClick={download} disabled={!report.data}>
          <Download size={16} />
          Raporu indir
        </button>
      </div>
      <ErrorNotice message={error || report.error} />
      <p className="notice">
        Yalnız bu kullanıcı ve projedeki servis çağrıları gözlenir. Diğer
        kullanıcıların veya dışa aktarılan paketlerin kullanımı bilinmiyor.
        Saklama süresi pencereyi kısaltabilir. Yeni paketler ilk 7 gün temizlik
        adayı sayılmaz.
      </p>
      <div className="toolbar">
        <span>{selected.length} paket seçildi</span>
        <button
          disabled={!selected.length || busy}
          onClick={() => void preview("archive")}
        >
          <Archive size={16} />
          Arşivlemeyi incele
        </button>
        <button
          disabled={!selected.length || busy}
          onClick={() => void preview("restore")}
        >
          <RotateCcw size={16} />
          Geri almayı incele
        </button>
        <button
          disabled={!selected.length || busy}
          onClick={() => void preview("delete")}
        >
          <Trash2 size={16} /> Kalıcı silmeyi incele
        </button>
      </div>
      {pending && (
        <section className="panel">
          <h2>Etki önizlemesi</h2>
          <p>{pending.preview.effect}</p>
          <p>
            Korunan, sabitlenmiş veya bu sırada değişen paketler öğe bazında
            reddedilir.
          </p>
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
              İşlemi uygula
            </button>
            <button disabled={busy} onClick={() => setPending(null)}>
              Vazgeç
            </button>
          </div>
        </section>
      )}
      {result && (
        <section className="panel" aria-live="polite">
          <h2>İşlem sonuçları</h2>
          <ResultList value={result} />
        </section>
      )}
      <section className="panel">
        <h2>Bekleyen dosya temizliği</h2>
        <p>
          Silme kararı verilmiş paketlerin kalan dosyalarıdır. Sürdürme işlemi
          yeni bir paket silmez. Her çağrı en fazla 25 revision temizler.
        </p>
        <ErrorNotice message={cleanups.error} />
        <Refresh run={cleanups.refresh} loading={cleanups.loading} />
        {cleanups.data?.items.map((item) => (
          <div className="toolbar" key={item.skill_id}>
            <code>{item.skill_id}</code>
            <button disabled={busy} onClick={() => void resume(item.skill_id)}>
              Temizliği sürdür
            </button>
          </div>
        ))}
        {cleanups.data && !cleanups.data.items.length && (
          <p>Bu sayfada bekleyen temizlik yok.</p>
        )}
        {cleanupAfter && (
          <button disabled={busy} onClick={() => setCleanupAfter("")}>
            İlk sayfa
          </button>
        )}
        {cleanups.data?.next && (
          <button
            disabled={busy}
            onClick={() => setCleanupAfter(cleanups.data!.next!)}
          >
            Sonraki temizlikler
          </button>
        )}
      </section>
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Seç</th>
              <th>Paket</th>
              <th>Gözlem</th>
              <th>Görünme / yükleme</th>
              <th>Script / hata</th>
            </tr>
          </thead>
          <tbody>
            {report.data?.items.map((item) => (
              <tr key={item.skill_id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${item.name} seç`}
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
                      ? "Proje"
                      : item.scope.startsWith("personal:")
                        ? "Kişisel"
                        : "Çalışma alanı"}
                    {item.pinned ? " · Sabit" : ""}
                    {item.protected ? " · Korunuyor" : ""}
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
            title="Bu kapsamda paket yok"
            detail="Skill kütüphanesinden bir paket aktarabilirsiniz."
          />
        )}
      </section>
      <Retention project={project} refresh={report.refresh} />
      <div className="toolbar">
        {after && <button onClick={reset}>İlk sayfa</button>}
        {report.data?.next && (
          <button
            onClick={() => {
              setAfter(report.data!.next!);
              setSelected([]);
              setPending(null);
            }}
          >
            Sonraki 50 paket
          </button>
        )}
        {report.data && (
          <small>
            {date(report.data.window.since)} – {date(report.data.window.until)}
          </small>
        )}
      </div>
    </>
  );
}
function ResultList({ value }: { value: Result }) {
  return (
    <ul>
      {value.items.map((item) => (
        <li key={item.skill_id}>
          <code>{item.name ?? item.skill_id.slice(0, 8)}</code>
          {item.revision_count !== undefined
            ? ` · ${item.revision_count} revision`
            : ""}
          :{" "}
          {item.error?.message ??
            (item.status === "eligible"
              ? "Uygun"
              : item.status === "completed"
                ? "Tamamlandı"
                : item.status === "pending_cleanup"
                  ? "Dosya temizliği bekliyor"
                  : "Engellendi")}
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
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Özel kayıtların saklanması</h2>
      <p>
        Etkin süre: {settings.data?.values.retentionDays ?? "Bilinmiyor"} gün.
        Servis bu politikayı arka planda uygular. Şimdi çalıştırmak yalnız kendi
        süresi dolmuş kayıtlarınızı temizler.
      </p>
      <p>
        Tamamlanmış işlerin özel metni, eski dersler ve gözlemler silinir; aktif
        işler, paket sürümleri, maliyet ve tekrar kayıtları korunur. Bu içerik
        temizliği geri alınamaz; eski yedekleri değiştirmez.
      </p>
      <button disabled={busy || !settings.data} onClick={() => void clean()}>
        {busy ? "Temizleniyor…" : "Süresi dolan özel kayıtları şimdi temizle"}
      </button>
      <ErrorNotice message={error || settings.error} />
      {result && (
        <p role="status">
          {result.scrubbed_runs} iş metni, {result.deleted_lessons} ders,{" "}
          {result.deleted_observations} gözlem, {result.deleted_events} olay
          temizlendi.
          {result.may_have_more
            ? " Kalan kayıtlar için sonraki sınırlı tarama gerekiyor."
            : ""}
        </p>
      )}
    </section>
  );
}
