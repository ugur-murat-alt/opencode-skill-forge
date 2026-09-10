import { useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { errorCode } from "./api";
import { useLang } from "./i18n/lang";
import { useResource, ErrorNotice, Empty, Status, date } from "./ui";
export function Installations({ project }: { project: string }) {
  const { t, lang, err } = useLang();
  const resource = useResource<{
    items: {
      id: string;
      client: string;
      version: string | null;
      directory: string;
      health: string;
      last_seen: number | null;
      capabilities: { handoff: string };
    }[];
    next?: string | null;
  }>(`/api/installations?project_ref=${encodeURIComponent(project)}`);
  const [client, setClient] = useState("codex"),
    [directory, setDirectory] = useState(""),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const quoted = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
  const command = `skill-forge install --client ${client} --project ${quoted(directory || t("installs.dirExample"))} --project-ref ${quoted(project)}`;
  return (
    <>
      <h1>{t("installs.title")}</h1>
      <p className="subtitle">{t("installs.subtitle")}</p>
      <ErrorNotice message={resource.error || error} />
      <section className="panel">
        <h2>{t("installs.connectTitle")}</h2>
        <p>{t("installs.connectDetail")}</p>
        <div className="form-grid">
          <label>
            {t("installs.clientLabel")}
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label>
            {t("installs.dirLabel")}
            <input
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder={t("installs.dirPh")}
            />
          </label>
        </div>
        <pre className="code-view">{command}</pre>
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(command)
              .then(() => setCopied(true))
              .catch((e) => setError(errorCode(e)))
          }
        >
          <Copy size={16} />
          {copied ? t("installs.copied") : t("installs.copy")}
        </button>
        <p className="helper">
          {client === "codex"
            ? t("installs.codexHelper")
            : t("installs.claudeHelper")}{" "}
          {t("installs.hookNote")}
        </p>
      </section>
      <section className="panel">
        <h2>{t("installs.chatTitle")}</h2>
        <p>{t("installs.chatDetail1")}</p>
        <p>{t("installs.chatDetail2")}</p>
        <a
          className="button"
          href="https://developers.openai.com/plugins/build/auth"
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={16} /> {t("installs.officialContract")}
        </a>
      </section>
      <section className="panel table-panel">
        <h2>{t("installs.observedTitle")}</h2>
        <table>
          <thead>
            <tr>
              <th>{t("installs.thClient")}</th>
              <th>{t("installs.thDir")}</th>
              <th>{t("installs.thHealth")}</th>
              <th>{t("installs.thLastSeen")}</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.client}
                  <small className="description">
                    {item.version ?? t("installs.versionUnknown")}
                  </small>
                </td>
                <td className="mono">{item.directory}</td>
                <td>
                  <Status value={item.health} />
                </td>
                <td>
                  {item.last_seen
                    ? date(item.last_seen, lang)
                    : t("installs.neverSeen")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {resource.data?.items.length === 0 && (
          <Empty title={t("installs.emptyInstalls")} />
        )}
        {(resource.next !== null || resource.incomplete) && (
          <div className="toolbar">
            <button
              data-testid="installations-load-more"
              disabled={resource.loadingMore}
              onClick={() => void resource.loadMore()}
            >
              {resource.loadingMore
                ? t("installs.loadingMore")
                : t("installs.loadMore")}
            </button>
            <small className="description" data-testid="installations-count">
              {t("installs.shownCount", {
                count: resource.data?.items.length ?? 0,
              })}
            </small>
          </div>
        )}
        {resource.pageError && (
          <p
            className="error"
            role="alert"
            data-testid="installations-page-error"
          >
            {t("installs.partialRetry", {
              code: err(resource.pageError),
            })}
          </p>
        )}
        {resource.incomplete && (
          <p className="helper" data-testid="installations-limit-notice">
            {t("installs.limitNotice")}
          </p>
        )}
      </section>
    </>
  );
}
