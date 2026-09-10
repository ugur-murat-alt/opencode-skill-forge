import { useCallback, useEffect, useState, useRef } from "react";
import { Inbox, RefreshCw } from "lucide-react";
import {
  api,
  cursorOrderFor,
  errorCode,
  pageItemKey,
  walkPages,
  type PageLike,
} from "./api";
import { useLang, type Locale } from "./i18n/lang";
type ResourceItem<T> = T extends { items: (infer I)[] } ? I : never;
function isPaged(value: unknown): value is { items: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { items?: unknown }).items)
  );
}
export interface Resource<T> {
  data: T | null;
  error: string;
  loading: boolean;
  refresh: () => Promise<void>;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
  /** Cursor for a further page when the server still offers one. */
  next: string | null;
  loadingMore: boolean;
  /** Explicit bound reached while rows remain; never silently hidden. */
  incomplete: boolean;
  /** Continuation failure code; already loaded rows are preserved. */
  pageError: string;
  loadMore: () => Promise<void>;
}
export function useResource<T>(
  path: string | null,
  options?: { follow?: boolean; maxPages?: number },
): Resource<T> {
  const follow = options?.follow ?? false;
  const maxPages = options?.maxPages ?? 50;
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [pageError, setPageError] = useState(""),
    [loadingMore, setLoadingMore] = useState(false),
    [incomplete, setIncomplete] = useState(false),
    [next, setNext] = useState<string | null>(null);
  const generation = useRef(0);
  const nextRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const cursors = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    if (!path) return;
    const request = ++generation.current;
    cursors.current = new Set();
    nextRef.current = null;
    loadingMoreRef.current = false;
    setLoading(true);
    setError("");
    setPageError("");
    setIncomplete(false);
    setNext(null);
    try {
      const start = await api<unknown>(path);
      if (request !== generation.current) return;
      if (!isPaged(start)) {
        // Non-paged endpoints answer with an array or a plain object.
        setData(start as T);
        return;
      }
      const page = start as unknown as PageLike<ResourceItem<T>>;
      const write = (items: ResourceItem<T>[], cursor: string | null) => {
        nextRef.current = cursor;
        setNext(cursor);
        setData(
          (current) =>
            ({
              ...((current ?? page) as object),
              items,
              next: cursor,
            }) as T,
        );
      };
      write(page.items ?? [], page.next ?? null);
      if (!follow || page.next === null || page.next === undefined) return;
      // Issue #15/#29: follow bounded keyset pages. Each page is committed
      // immediately, a repeated/regressing cursor stops the walk, and a
      // later failure keeps the partial result visible with pageError set.
      const result = await walkPages<ResourceItem<T>>(path, page, {
        maxPages,
        isCancelled: () => request !== generation.current,
        seenCursors: cursors.current,
        cursorOrder: cursorOrderFor(path),
        onPage: ({ items, next: cursor }) => write(items, cursor),
      });
      if (request !== generation.current) return;
      setIncomplete(result.incomplete);
      if (result.error && !result.cancelled)
        setPageError(errorCode(result.error));
    } catch (error) {
      if (request === generation.current) setError(errorCode(error));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [path, follow, maxPages]);
  const loadMore = useCallback(async () => {
    const cursor = nextRef.current;
    if (!path || !cursor || loadingMoreRef.current) return;
    const request = generation.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setPageError("");
    try {
      const page = await api<PageLike<ResourceItem<T>>>(
        `${path}${path.includes("?") ? "&" : "?"}after=${encodeURIComponent(cursor)}`,
      );
      if (request !== generation.current) return;
      const cursorNext = page.next ?? null;
      if (
        cursors.current.has(cursor) ||
        (cursorNext !== null && cursors.current.has(cursorNext))
      ) {
        setPageError("invalid_cursor");
        return;
      }
      cursors.current.add(cursor);
      if (cursorNext !== null) cursors.current.add(cursorNext);
      nextRef.current = cursorNext;
      setNext(cursorNext);
      setIncomplete(false);
      setData((current) => {
        const base = (current ?? {}) as { items?: ResourceItem<T>[] };
        const existing = new Set((base.items ?? []).map(pageItemKey));
        const merged = [
          ...(base.items ?? []),
          ...(page.items ?? []).filter(
            (item) => !existing.has(pageItemKey(item)),
          ),
        ];
        return { ...(base as object), items: merged, next: cursorNext } as T;
      });
    } catch (error) {
      if (request === generation.current) setPageError(errorCode(error));
    } finally {
      if (request === generation.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void refresh();
    return () => {
      generation.current++;
      loadingMoreRef.current = false;
    };
  }, [refresh]);
  return {
    data,
    error,
    loading,
    refresh,
    setData,
    next,
    loadingMore,
    incomplete,
    pageError,
    loadMore,
  };
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
