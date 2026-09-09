import { Members } from "./Members";
import { useEffect, useState, type FormEvent } from "react";
import { api, errorCode, type Project } from "./api";
import { useLang } from "./i18n/lang";
import { useResource, ErrorNotice } from "./ui";
export function Projects({
  project,
  admin,
  userId,
  onChange,
}: {
  project?: string;
  admin: boolean;
  userId: string;
  onChange: () => Promise<void>;
}) {
  const { t } = useLang();
  const projects = useResource<{ items: Project[] }>("/api/projects"),
    envs = useResource<{ id: string; name: string }[]>("/api/environments"),
    [name, setName] = useState(""),
    [env, setEnv] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, ...(env ? { environment_id: env } : {}) }),
      });
      setName("");
      setEnv("");
      await projects.refresh();
      await onChange();
    } catch (error) {
      setError(errorCode(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>{t("projects.title")}</h1>
      <p className="subtitle">{t("projects.subtitle")}</p>
      <ErrorNotice message={error || projects.error} />
      <section className="panel">
        <h2>{admin ? t("projects.newProject") : t("projects.authorized")}</h2>
        {admin && (
          <form className="toolbar" onSubmit={create}>
            <label className="search-field">
              {t("projects.nameLabel")}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label>
              {t("projects.envLabel")}
              <select value={env} onChange={(e) => setEnv(e.target.value)}>
                <option value="">{t("projects.defaultEnv")}</option>
                {(envs.data ?? []).map((e) => (
                  <option value={e.id} key={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={busy}>
              {busy ? t("projects.creating") : t("projects.createProject")}
            </button>
          </form>
        )}
        {projects.data && (
          <table>
            <thead>
              <tr>
                <th>{t("projects.thProject")}</th>
                <th>{t("projects.thRef")}</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td className="mono">{item.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Settings project={project} userId={userId} />
      {admin && project && <Members key={project} project={project} />}
    </>
  );
}
function Settings({ project, userId }: { project?: string; userId: string }) {
  const { t } = useLang();
  const numericFields = [
    { key: "maxCalls", label: t("projects.numMaxCalls"), min: 1, max: 100 },
    {
      key: "maxTokens",
      label: t("projects.numMaxTokens"),
      min: 64,
      max: 1000000,
    },
    {
      key: "maxCostMicros",
      label: t("projects.numMaxCost"),
      min: 0,
      max: 1000000000,
    },
    {
      key: "concurrency",
      label: t("projects.numConcurrency"),
      min: 1,
      max: 1000,
    },
    {
      key: "retentionDays",
      label: t("projects.numRetention"),
      min: 1,
      max: 3650,
    },
  ];
  const booleanFields = [
    { key: "evolutionEnabled", label: t("projects.boolEvolution") },
    { key: "allowPaid", label: t("projects.boolAllowPaid") },
    { key: "dependencyInstall", label: t("projects.boolDependency") },
  ];
  const [scope, setScope] = useState("workspace"),
    [values, setValues] = useState<Record<string, any>>({}),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const config = useResource<{ revision: number; values: Record<string, any> }>(
      `/api/settings?scope=${encodeURIComponent(scope)}`,
    ),
    effective = useResource<{
      values: Record<string, any>;
      sources: Record<string, string>;
    }>(
      `/api/settings/effective${project ? `?project_ref=${encodeURIComponent(project)}` : ""}`,
    );
  useEffect(() => {
    setValues(config.data?.values ?? {});
    setSaved(false);
  }, [config.data]);
  function change(key: string, value: unknown) {
    setValues((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
    setSaved(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config.data) return;
    setError("");
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          scope,
          base_revision: config.data.revision,
          values,
        }),
      });
      await config.refresh();
      await effective.refresh();
      setSaved(true);
    } catch (error) {
      setError(errorCode(error));
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{t("projects.settingsTitle")}</h2>
        <label>
          {t("projects.scopeLabel")}
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="workspace">{t("projects.scopeWorkspace")}</option>
            {project && (
              <option value={`project:${project}`}>
                {t("projects.scopeProject")}
              </option>
            )}
            <option value={`personal:${userId}`}>
              {t("projects.scopePersonal")}
            </option>
            <option value="policy">{t("projects.scopePolicy")}</option>
          </select>
        </label>
      </div>
      <ErrorNotice message={error || config.error || effective.error} />
      <form onSubmit={save}>
        <div className="form-grid">
          {booleanFields.map((field) => (
            <label key={field.key}>
              {field.label}
              <select
                value={
                  values[field.key] === undefined
                    ? "inherit"
                    : String(values[field.key])
                }
                onChange={(e) =>
                  change(
                    field.key,
                    e.target.value === "inherit"
                      ? undefined
                      : e.target.value === "true",
                  )
                }
              >
                <option value="inherit">{t("projects.inherit")}</option>
                <option value="true">{t("projects.on")}</option>
                <option value="false">{t("projects.off")}</option>
              </select>
              <small>
                {t("projects.effective", {
                  value: String(effective.data?.values[field.key] ?? "—"),
                })}
              </small>
            </label>
          ))}
          {numericFields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                type="number"
                min={field.min}
                max={field.max}
                placeholder={t("projects.inheritedPh", {
                  value: effective.data?.values[field.key] ?? "—",
                })}
                value={values[field.key] ?? ""}
                onChange={(e) =>
                  change(
                    field.key,
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
              />
            </label>
          ))}
          {[
            {
              key: "allowedOrigins",
              label: t("projects.originsAllowed"),
            },
            {
              key: "scriptAllowedOrigins",
              label: t("projects.originsScript"),
            },
          ].map((field) => (
            <label key={field.key}>
              {field.label}
              <textarea
                rows={3}
                value={(values[field.key] ?? []).join("\n")}
                onChange={(e) =>
                  change(
                    field.key,
                    e.target.value.trim()
                      ? e.target.value
                          .split("\n")
                          .map((v) => v.trim())
                          .filter(Boolean)
                      : undefined,
                  )
                }
                placeholder={t("projects.originsPh")}
              />
            </label>
          ))}
        </div>
        <button className="primary" disabled={!config.data}>
          {t("projects.saveSettings")}
        </button>
        {saved && (
          <span className="saved" role="status">
            {t("projects.saved")}
          </span>
        )}
        <small className="helper">
          {t("projects.helper", { revision: config.data?.revision ?? "—" })}
        </small>
      </form>
      <details>
        <summary>{t("projects.effectiveDetails")}</summary>
        <table>
          <thead>
            <tr>
              <th>{t("projects.thSetting")}</th>
              <th>{t("projects.thValue")}</th>
              <th>{t("projects.thSource")}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(effective.data?.values ?? {}).map(
              ([key, value]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{JSON.stringify(value)}</td>
                  <td>{effective.data?.sources[key]}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </details>
    </section>
  );
}
