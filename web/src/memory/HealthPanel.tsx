import { useLang } from "../i18n/lang";
import { ErrorNotice, Refresh, date, useResource } from "../ui";
import type { MemoryHealth } from "./api";

/**
 * Issue #37 (M04) phase B: space-scoped memory health. The endpoint returns
 * counts and error codes only; no note or tenant names are rendered here.
 */
export function HealthPanel({ spaceId }: { spaceId: string }) {
  const { t, lang, err } = useLang();
  const health = useResource<MemoryHealth>(
    `/api/memory/health?space_id=${encodeURIComponent(spaceId)}`,
  );
  const data = health.data;
  const lastIndexed =
    data?.index.last_indexed_at === null ||
    data?.index.last_indexed_at === undefined
      ? "—"
      : date(data.index.last_indexed_at, lang);
  const oldestPending =
    data?.events.oldest_pending_at === null ||
    data?.events.oldest_pending_at === undefined
      ? "—"
      : date(data.events.oldest_pending_at, lang);
  return (
    <section
      className="memory-health-panel"
      aria-label={t("memory.health.title")}
    >
      <div className="memory-heading">
        <h2>{t("memory.health.title")}</h2>
        <Refresh run={() => void health.refresh()} loading={health.loading} />
      </div>
      <p className="subtitle">{t("memory.health.subtitle")}</p>
      <ErrorNotice message={health.error} />
      {data && (
        <>
          <h3>{t("memory.health.index")}</h3>
          <div className="memory-facts">
            <div>
              <dt>{t("memory.health.heads")}</dt>
              <dd data-testid="memory-health-heads">{data.index.heads}</dd>
            </div>
            <div>
              <dt>{t("memory.health.stale")}</dt>
              <dd data-testid="memory-health-stale">{data.index.stale}</dd>
            </div>
            <div>
              <dt>{t("memory.health.lastIndexed")}</dt>
              <dd className="mono" data-testid="memory-health-indexed-at">
                {lastIndexed}
              </dd>
            </div>
          </div>
          <h3>{t("memory.health.events")}</h3>
          <div className="memory-facts">
            <div>
              <dt>{t("memory.health.pending")}</dt>
              <dd data-testid="memory-health-pending">{data.events.pending}</dd>
            </div>
            <div>
              <dt>{t("memory.health.rejected")}</dt>
              <dd>{data.events.rejected}</dd>
            </div>
            <div>
              <dt>{t("memory.health.oldestPending")}</dt>
              <dd className="mono">{oldestPending}</dd>
            </div>
          </div>
          <h3>{t("memory.health.jobs")}</h3>
          <div className="memory-facts">
            <div>
              <dt>{t("memory.health.active")}</dt>
              <dd data-testid="memory-health-active">{data.jobs.active}</dd>
            </div>
            <div>
              <dt>{t("memory.health.failed24h")}</dt>
              <dd data-testid="memory-health-failed">{data.jobs.failed_24h}</dd>
            </div>
            <div>
              <dt>{t("memory.health.lastFailure")}</dt>
              <dd data-testid="memory-health-last-failure">
                {data.jobs.last_failure
                  ? `${err(data.jobs.last_failure.error_code ?? "unknown")} · ${date(data.jobs.last_failure.updated_at, lang)}`
                  : t("memory.health.none")}
              </dd>
            </div>
          </div>
          <div className="memory-facts">
            <div>
              <dt>{t("memory.health.spool")}</dt>
              <dd data-testid="memory-health-spool">
                {data.spool === null
                  ? t("memory.health.spoolUnavailable")
                  : JSON.stringify(data.spool)}
              </dd>
            </div>
            <div>
              <dt>{t("memory.health.week")}</dt>
              <dd>
                {date(data.week.week_start, lang)} –{" "}
                {date(data.week.week_end, lang)} · {data.week.timezone}
              </dd>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
