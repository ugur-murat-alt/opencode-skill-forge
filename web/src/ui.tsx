import { useCallback, useEffect, useState, useRef } from "react";
import { Inbox, RefreshCw } from "lucide-react";
import { api, errorCode } from "./api";
import { useLang, type Locale } from "./i18n/lang";
export function useResource<T>(
  path: string | null,
  options?: { follow?: boolean; maxPages?: number },
) {
  const follow = options?.follow ?? false;
  const maxPages = options?.maxPages ?? 50;
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
      let value = await api<T & { next?: string | null; items?: unknown[] }>(
        path,
      );
      if (follow) {
        // Issue #15: follow bounded keyset pages so management/history lists
        // reach the whole authorized set instead of stopping at the first
        // page. Follow failures keep the partial page instead of masking it.
        let pages = 0;
        while ((value as { next?: string | null }).next && pages < maxPages) {
          const cursor = encodeURIComponent(
            String((value as { next?: string | null }).next),
          );
          const page = await api<
            T & { next?: string | null; items?: unknown[] }
          >(`${path}${path.includes("?") ? "&" : "?"}after=${cursor}`);
          value = {
            ...value,
            items: [
              ...((value as { items?: unknown[] }).items ?? []),
              ...((page as { items?: unknown[] }).items ?? []),
            ],
            next: (page as { next?: string | null }).next ?? null,
          } as T & { next?: string | null };
          pages++;
        }
      }
      if (request === generation.current) setData(value);
    } catch (error) {
      if (request === generation.current) setError(errorCode(error));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [path, follow, maxPages]);
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
  const { err } = useLang();
  return message ? (
    <p className="error" role="alert">
      {err(message)}
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
  const { t } = useLang();
  return (
    <button
      className="icon-button"
      title={t("common.refresh")}
      aria-label={t("aria.refresh")}
      disabled={loading}
      onClick={() => void run()}
    >
      <RefreshCw size={17} />
    </button>
  );
}
export function Status({ value }: { value: string }) {
  const { st } = useLang();
  return <span className={`status status-${value}`}>{st(value)}</span>;
}
export function date(value: number, lang: Locale) {
  return new Date(value).toLocaleString(lang === "tr" ? "tr-TR" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
export function money(
  value: number | null,
  unknownLabel: string,
  lang: Locale,
) {
  return value === null
    ? unknownLabel
    : new Intl.NumberFormat(lang === "tr" ? "tr-TR" : "en-US", {
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
  const { t, lang } = useLang();
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>{t("jobs.table.job")}</th>
            <th>{t("jobs.table.kind")}</th>
            <th>{t("jobs.table.status")}</th>
            <th>{t("jobs.table.started")}</th>
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
              <td>{t("jobs.kindEvolve")}</td>
              <td>
                <Status value={job.status} />
              </td>
              <td>{date(job.created_at, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <Empty title={t("jobs.empty")} />}
    </>
  );
}
