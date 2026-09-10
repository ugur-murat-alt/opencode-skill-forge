import { useState, type FormEvent } from "react";
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
interface PromptDraft {
  text: string;
  base: number;
}

/** Issue #31: unsent prompt text is kept per tenant+scope. The tenant is part
 * of the key, so a draft written in one tenant can never be offered in
 * another; the visible tenant is passed by the shell. Drafts also survive a
 * browser refresh through sessionStorage (per tab, never sent to a server). */
export function promptScopeKey(tenant: string, scope: string): string {
  return `${tenant}\u0000${scope}`;
}
const PROMPT_STORAGE_PREFIX = "forge-prompt-draft:";
const promptDrafts = new Map<string, PromptDraft>();
export function readPromptDraft(key: string): PromptDraft | null {
  let draft = promptDrafts.get(key);
  if (!draft && typeof sessionStorage !== "undefined") {
    try {
      const raw = sessionStorage.getItem(`${PROMPT_STORAGE_PREFIX}${key}`);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PromptDraft>;
        if (parsed && typeof parsed.text === "string") {
          draft = { text: parsed.text, base: Number(parsed.base ?? 0) };
          promptDrafts.set(key, draft);
        }
      }
    } catch {}
  }
  return draft ? { ...draft } : null;
}
export function writePromptDraft(key: string, draft: PromptDraft): void {
  promptDrafts.set(key, { ...draft });
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      `${PROMPT_STORAGE_PREFIX}${key}`,
      JSON.stringify(draft),
    );
  } catch {}
}
export function clearPromptDraft(key: string): void {
  promptDrafts.delete(key);
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(`${PROMPT_STORAGE_PREFIX}${key}`);
  } catch {}
}
function snapshotPromptDrafts(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, draft] of promptDrafts) snapshot[key] = draft.text;
  if (typeof sessionStorage !== "undefined") {
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const storageKey = sessionStorage.key(i) ?? "";
        if (!storageKey.startsWith(PROMPT_STORAGE_PREFIX)) continue;
        const key = storageKey.slice(PROMPT_STORAGE_PREFIX.length);
        const parsed = JSON.parse(
          sessionStorage.getItem(storageKey) ?? "{}",
        ) as Partial<PromptDraft>;
        if (typeof parsed.text === "string" && !(key in snapshot))
          snapshot[key] = parsed.text;
      }
    } catch {}
  }
  return snapshot;
}

export function AgentPrompts({ tenant }: { tenant: string }) {
  const [scope, setScope] = useState("org");
  const [drafts, setDrafts] =
    useState<Record<string, string>>(snapshotPromptDrafts);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { t, lang } = useLang();
  const envs = useResource<{ id: string; name: string }[]>("/api/environments");
  const resource = useResource<{
    active: ActiveRow | null;
    history: PromptRow[];
  }>(`/api/agent-prompts?scope=${encodeURIComponent(scope)}`);
  const active = resource.data?.active;
  const scopeKey = promptScopeKey(tenant, scope);
  const text = drafts[scopeKey] ?? active?.content ?? "";
  const base = readPromptDraft(scopeKey)?.base ?? active?.version ?? 0;
  const dirty =
    drafts[scopeKey] !== undefined && drafts[scopeKey] !== active?.content;
  function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    // Issue #31: the request carries a fixed snapshot; a refresh or a scope
    // move during the save cannot mix newer editor text into it.
    const snapshot = text;
    const baseVersion = base;
    setBusy(true);
    setError("");
    void api("/api/agent-prompts", {
      method: "PUT",
      body: JSON.stringify({
        scope,
        base_version: baseVersion,
        content: snapshot,
      }),
    })
      .then(() => {
        setDrafts((current) => {
          if (current[scopeKey] !== snapshot) return current;
          const next = { ...current };
          delete next[scopeKey];
          return next;
        });
        clearPromptDraft(scopeKey);
        return resource.refresh();
      })
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
              title={dirty ? t("prompts.dirty") : undefined}
              onChange={(e) => {
                const value = e.target.value;
                setDrafts((current) => ({ ...current, [scopeKey]: value }));
                writePromptDraft(scopeKey, { text: value, base });
              }}
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
