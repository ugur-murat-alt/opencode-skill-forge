import { useState } from "react";
import { Bell, Settings, Bot, Terminal, MessageSquare } from "lucide-react";
import { useLang } from "./i18n/lang";
import { api, errorCode } from "./api";
import {
  useResource,
  ErrorNotice,
  JobTable,
  Status,
  date,
  money,
  type Job,
} from "./ui";

interface UncertainReservation {
  id: string;
  run_id: string;
  project_id: string;
  reserved_micros: number;
}

interface AccountBudget {
  job_limit_micros: number;
  reserved_micros: number;
  uncertain_micros: number;
  spent_micros: number;
  uncertain_reservations: UncertainReservation[];
}

export function Overview({ project }: { project: string }) {
  const { t, st, lang } = useLang();
  const overview = useResource<{
    active_jobs: number;
    skill_packages: number;
    model_status: string;
    observed_cost_micros: number | null;
    account_budget: AccountBudget;
    jobs: Job[];
    events: { id: string; kind: string; created_at: number }[];
  }>(`/api/overview?project_ref=${encodeURIComponent(project)}`);
  const installations = useResource<{
    items: { client: string; health: string }[];
  }>(`/api/installations?project_ref=${encodeURIComponent(project)}`);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reconciling, setReconciling] = useState("");
  const [reconcileError, setReconcileError] = useState("");
  const data = overview.data;
  const budget = data?.account_budget;
  const reconcile = async (reservation: UncertainReservation) => {
    const raw = (amounts[reservation.id] ?? "").trim();
    const micros = Number(raw);
    if (raw === "" || !Number.isSafeInteger(micros) || micros < 0) {
      setReconcileError("invalid_usage");
      return;
    }
    setReconciling(reservation.id);
    setReconcileError("");
    try {
      await api(
        `/api/budget/reservations/${encodeURIComponent(reservation.id)}/reconcile`,
        { method: "POST", body: JSON.stringify({ actual_micros: micros }) },
      );
      setAmounts((current) => {
        const next = { ...current };
        delete next[reservation.id];
        return next;
      });
      await overview.refresh();
    } catch (error) {
      setReconcileError(errorCode(error));
    } finally {
      setReconciling("");
    }
  };
  return (
    <>
      <h1>{t("overview.title")}</h1>
      <p className="subtitle">{t("overview.subtitle")}</p>
      <ErrorNotice
        message={overview.error || installations.error || reconcileError}
      />
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
      <section className="panel budget-panel">
        <h2>{t("overview.budgetTitle")}</h2>
        <p className="subtitle">{t("overview.budgetSubtitle")}</p>
        <div className="metrics">
          <div>
            <span>{t("overview.jobLimit")}</span>
            <strong className="metric-text">
              {budget
                ? money(
                    budget.job_limit_micros,
                    t("overview.costUnknown"),
                    lang,
                  )
                : "—"}
            </strong>
          </div>
          <div>
            <span>{t("overview.inFlight")}</span>
            <strong className="metric-text">
              {budget
                ? money(budget.reserved_micros, t("overview.costUnknown"), lang)
                : "—"}
            </strong>
          </div>
          <div>
            <span>{t("overview.uncertainBudget")}</span>
            <strong className="metric-text">
              {budget
                ? money(
                    budget.uncertain_micros,
                    t("overview.costUnknown"),
                    lang,
                  )
                : "—"}
            </strong>
          </div>
          <div>
            <span>{t("overview.settledSpend")}</span>
            <strong className="metric-text">
              {budget
                ? money(budget.spent_micros, t("overview.costUnknown"), lang)
                : "—"}
            </strong>
          </div>
        </div>
        {budget && budget.uncertain_reservations.length > 0 && (
          <>
            <h3>{t("overview.uncertainList")}</h3>
            <ul className="events">
              {budget.uncertain_reservations.map((reservation) => (
                <li key={reservation.id}>
                  <span className="mono">{reservation.id}</span>
                  <span>
                    {money(
                      reservation.reserved_micros,
                      t("overview.costUnknown"),
                      lang,
                    )}
                  </span>
                  <input
                    aria-label={t("overview.reconcileAmount")}
                    inputMode="numeric"
                    placeholder={t("overview.reconcileAmount")}
                    value={amounts[reservation.id] ?? ""}
                    onChange={(event) =>
                      setAmounts((current) => ({
                        ...current,
                        [reservation.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    type="button"
                    disabled={reconciling === reservation.id}
                    onClick={() => void reconcile(reservation)}
                  >
                    {t("overview.reconcile")}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
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
