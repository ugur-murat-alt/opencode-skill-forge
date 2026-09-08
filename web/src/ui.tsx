import { useCallback, useEffect, useState, useRef } from "react";
import { Inbox, RefreshCw } from "lucide-react";
import { api } from "./api";
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!path) return;
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const value = await api<T>(path);
      if (request === generation.current) setData(value);
    } catch (error) {
      if (request === generation.current)
        setError(
          error instanceof Error ? error.message : "İşlem tamamlanamadı.",
        );
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  return { data, error, loading, refresh, setData };
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}
export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty">
      <Inbox size={44} strokeWidth={1.5} />
      <span>{title}</span>
      {detail && <small>{detail}</small>}
    </div>
  );
}
export function Refresh({
  run,
  loading,
}: {
  run: () => unknown;
  loading?: boolean;
}) {
  return (
    <button
      className="icon-button"
      title="Yenile"
      aria-label="Yenile"
      disabled={loading}
      onClick={() => void run()}
    >
      <RefreshCw size={17} />
    </button>
  );
}
const statusNames: Record<string, string> = {
  queued: "Kuyrukta",
  running: "Çalışıyor",
  retry_wait: "Tekrar bekliyor",
  completed: "Tamamlandı",
  no_op: "Değişiklik yok",
  rejected: "Reddedildi",
  failed: "Başarısız",
  cancelled: "İptal edildi",
  superseded: "Yerini yenisi aldı",
  improved: "İyileştirildi",
  unchanged: "Aynı bırakıldı",
  fallback: "Özgün metin",
  connected: "Bağlı",
  stale: "Güncel değil",
  unknown: "Bilinmiyor",
  configured: "Yapılandırıldı",
  unconfigured: "Yapılandırılmadı",
};
export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      {statusNames[value] ?? value}
    </span>
  );
}
export function date(value: number) {
  return new Date(value).toLocaleString("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
export function money(value: number | null) {
  return value === null
    ? "Bilinmiyor"
    : new Intl.NumberFormat("tr-TR", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 4,
      }).format(value / 1_000_000);
}
export interface Job {
  run_id: string;
  kind: string;
  status: string;
  created_at: number;
  error_code: string | null;
  result: any;
  result_available?: boolean;
  result_summary?: unknown;
  attempt: number;
}
export function JobTable({
  items,
  select,
}: {
  items: Job[];
  select?: (job: Job) => void;
}) {
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>İş</th>
            <th>Tür</th>
            <th>Durum</th>
            <th>Başlangıç</th>
          </tr>
        </thead>
        <tbody>
          {items.map((job) => (
            <tr key={job.run_id}>
              <td>
                {select ? (
                  <button
                    className="link-button mono"
                    onClick={() => select(job)}
                  >
                    {job.run_id.slice(0, 8)}
                  </button>
                ) : (
                  <span className="mono">{job.run_id.slice(0, 8)}</span>
                )}
              </td>
              <td>Skill geliştirme</td>
              <td>
                <Status value={job.status} />
              </td>
              <td>{date(job.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <Empty title="Henüz iş yok" />}
    </>
  );
}
