import { useEffect, useState, type FormEvent } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
import { useResource, ErrorNotice, Empty, Refresh, date } from "./ui";

interface PromptRow {
  version: number;
  created_by: string;
  created_at: number;
}
interface ActiveRow extends PromptRow {
  content: string;
}

export function AgentPrompts() {
  const [scope, setScope] = useState("org");
  const [text, setText] = useState("");
  const [base, setBase] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { t, lang } = useLang();
  const envs = useResource<{ id: string; name: string }[]>("/api/environments");
  const resource = useResource<{
    active: ActiveRow | null;
    history: PromptRow[];
  }>(`/api/agent-prompts?scope=${encodeURIComponent(scope)}`);
  function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    void api("/api/agent-prompts", {
      method: "PUT",
      body: JSON.stringify({ scope, base_version: base, content: text }),
    })
      .then(() => resource.refresh())
      .catch((e) => setError(errorCode(e)))
      .finally(() => setBusy(false));
  }
  function rollback(version: number) {
    setBusy(true);
    setError("");
    void api("/api/agent-prompts/rollback", {
      method: "POST",
      body: JSON.stringify({ scope, version }),
    })
      .then(() => resource.refresh())
      .catch((e) => setError(errorCode(e)))
      .finally(() => setBusy(false));
  }
  const active = resource.data?.active;
  useEffect(() => {
    setText(active?.content ?? "");
    setBase(active?.version ?? 0);
  }, [scope, active?.content, active?.version]);
  return (
    <>
      <div className="title-row">
        <div>
          <h1>{t("prompts.title")}</h1>
          <p className="subtitle">{t("prompts.subtitle")}</p>
        </div>
        <Refresh run={() => void resource.refresh()} />
      </div>
      <ErrorNotice message={error || resource.error} />
      <section className="panel">
        <div className="toolbar">
          <label>
            {t("prompts.scope")}
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="org">{t("prompts.orgDefault")}</option>
              {(envs.data ?? []).map((e) => (
                <option value={`environment:${e.id}`} key={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <form onSubmit={save}>
          <label>
            {t("prompts.systemPrompt")}
            <textarea
              rows={10}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              required
            />
          </label>
          <p>
            <small>{t("prompts.baseVersion", { base })}</small>
          </p>
          <button className="primary" disabled={busy}>
            {t("common.save")}
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>{t("prompts.activeVersion")}</h2>
        {active ? (
          <pre className="prompt-content">{active.content}</pre>
        ) : (
          <Empty title={t("prompts.empty")} detail={t("prompts.emptyDetail")} />
        )}
      </section>
      <section className="panel table-panel">
        <h2>{t("prompts.history")}</h2>
        <table>
          <thead>
            <tr>
              <th>{t("prompts.version")}</th>
              <th>{t("prompts.date")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(resource.data?.history ?? []).map((h) => (
              <tr key={h.version}>
                <td className="mono">
                  {t("prompts.versionShort", { version: h.version })}
                </td>
                <td>{date(h.created_at, lang)}</td>
                <td>
                  <button
                    className="link-button"
                    disabled={busy}
                    onClick={() => rollback(h.version)}
                  >
                    {t("prompts.rollback")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
