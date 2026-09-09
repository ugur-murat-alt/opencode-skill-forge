import { Bell, Settings, Bot, Terminal, MessageSquare } from "lucide-react";
import { useLang } from "./i18n/lang";
import {
  useResource,
  ErrorNotice,
  JobTable,
  Status,
  date,
  money,
  type Job,
} from "./ui";
export function Overview({ project }: { project: string }) {
  const { t, st, lang } = useLang();
  const overview = useResource<{
    active_jobs: number;
    skill_packages: number;
    model_status: string;
    observed_cost_micros: number | null;
    jobs: Job[];
    events: { id: string; kind: string; created_at: number }[];
  }>(`/api/overview?project_ref=${encodeURIComponent(project)}`);
  const installations = useResource<{
    items: { client: string; health: string }[];
  }>(`/api/installations?project_ref=${encodeURIComponent(project)}`);
  const data = overview.data;
  return (
    <>
      <h1>{t("overview.title")}</h1>
      <p className="subtitle">{t("overview.subtitle")}</p>
      <ErrorNotice message={overview.error || installations.error} />
      <section className="metrics" aria-label={t("overview.metricsAria")}>
        <div>
          <span>{t("overview.activeJobs")}</span>
          <strong>{data?.active_jobs ?? "—"}</strong>
        </div>
        <div>
          <span>{t("overview.skillPackages")}</span>
          <strong>{data?.skill_packages ?? "—"}</strong>
        </div>
        <div>
          <span>{t("overview.modelStatus")}</span>
          <strong className="metric-text">
            {data
              ? data.model_status === "configured"
                ? st("configured")
                : st("unconfigured")
              : "—"}
          </strong>
        </div>
        <div>
          <span>{t("overview.observedCost")}</span>
          <strong className="metric-text">
            {data
              ? money(
                  data.observed_cost_micros,
                  t("overview.costUnknown"),
                  lang,
                )
              : "—"}
          </strong>
        </div>
      </section>
      <div className="overview-grid">
        <section className="panel jobs-panel">
          <h2>{t("overview.recentJobs")}</h2>
          {data ? (
            <JobTable items={data.jobs} />
          ) : (
            <p className="loading" role="status">
              {t("shell.loading")}
            </p>
          )}
        </section>
        <section className="panel connection-panel">
          <h2>{t("overview.clients")}</h2>
          {[
            { client: "claude", label: "Claude Code", Icon: Bot },
            { client: "codex", label: "Codex", Icon: Terminal },
            { client: "chatgpt", label: "ChatGPT App", Icon: MessageSquare },
          ].map(({ client, label, Icon }) => {
            const record = installations.data?.items.find(
              (item) => item.client === client,
            );
            return (
              <div className="connection" key={client}>
                <span className="client-icon">
                  <Icon size={19} />
                </span>
                <span>{label}</span>
                <Status value={record?.health ?? "unknown"} />
              </div>
            );
          })}
          <a className="panel-link" href="#installations">
            <Settings size={15} /> {t("overview.manageInstalls")}
          </a>
        </section>
      </div>
      <section className="panel events-panel">
        <h2>{t("overview.recentEvents")}</h2>
        {data?.events.length ? (
          <ul className="events">
            {data.events.map((event) => (
              <li key={event.id}>
                <Bell size={17} />
                <span>{event.kind}</span>
                <time>{date(event.created_at, lang)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">
            <Bell size={44} strokeWidth={1.5} />
            <span>{t("overview.noEvents")}</span>
          </div>
        )}
      </section>
    </>
  );
}
