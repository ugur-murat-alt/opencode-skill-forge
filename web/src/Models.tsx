import { useState } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
import { useResource, ErrorNotice, money } from "./ui";
interface Profile {
  role: string;
  revision: number;
  profile: {
    provider: string;
    model: string;
    baseUrl?: string;
    maxOutputTokens: number;
    allowPaid: boolean;
  } | null;
  credential: string;
  health: string;
}
export function Models({ project }: { project: string }) {
  const { t, lang } = useLang();
  const profiles = useResource<{ items: Profile[] }>("/api/providers"),
    policy = useResource<{
      values: Record<string, any>;
      sources: Record<string, string>;
    }>(`/api/settings/effective?project_ref=${encodeURIComponent(project)}`);
  return (
    <>
      <h1>{t("models.title")}</h1>
      <p className="subtitle">{t("models.subtitle")}</p>
      <ErrorNotice message={profiles.error || policy.error} />
      <div className="policy-strip">
        <span>
          {t("models.paidCalls")}{" "}
          <strong>
            {policy.data?.values.allowPaid
              ? t("models.paidAllowed")
              : t("models.paidOff")}
          </strong>
        </span>
        <span>
          {t("models.costCap")}{" "}
          <strong>
            {money(
              policy.data?.values.maxCostMicros ?? null,
              t("status.unknown"),
              lang,
            )}
          </strong>
        </span>
        <span>
          {t("models.turnLimit")}{" "}
          <strong>{policy.data?.values.maxCalls ?? "—"}</strong>
        </span>
      </div>
      {profiles.data?.items.map((item) => (
        <ProfileForm
          key={`${item.role}:${item.revision}`}
          item={item}
          refresh={profiles.refresh}
        />
      ))}
      <section className="panel">
        <h2>{t("models.limitsTitle")}</h2>
        <p>{t("models.limitsDetail")}</p>
        <table>
          <thead>
            <tr>
              <th>{t("models.thSetting")}</th>
              <th>{t("models.thValue")}</th>
              <th>{t("models.thSource")}</th>
            </tr>
          </thead>
          <tbody>
            {[
              "allowedOrigins",
              "allowPaid",
              "maxCalls",
              "maxTokens",
              "maxCostMicros",
              "concurrency",
            ].map((key) => (
              <tr key={key}>
                <td>{key}</td>
                <td>{JSON.stringify(policy.data?.values[key] ?? null)}</td>
                <td>{policy.data?.sources[key]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
function ProfileForm({
  item,
  refresh,
}: {
  item: Profile;
  refresh: () => Promise<void>;
}) {
  const { t } = useLang();
  const [provider, setProvider] = useState(item.profile?.provider ?? "ollama"),
    [model, setModel] = useState(item.profile?.model ?? ""),
    [url, setUrl] = useState(item.profile?.baseUrl ?? ""),
    [tokens, setTokens] = useState(item.profile?.maxOutputTokens ?? 4096),
    [paid, setPaid] = useState(item.profile?.allowPaid ?? false),
    [credential, setCredential] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/api/providers", {
        method: "PUT",
        body: JSON.stringify({
          role: item.role,
          base_revision: item.revision,
          profile: {
            provider,
            model,
            ...(url ? { baseUrl: url } : {}),
            maxOutputTokens: tokens,
            allowPaid: paid,
          },
          ...(credential ? { credential } : {}),
        }),
      });
      setCredential("");
      await refresh();
    } catch (error) {
      setError(errorCode(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>
          {item.role === "skill" ? t("models.roleSkill") : t("models.roleEval")}
        </h2>
        <small>
          {t("models.meta", {
            revision: item.revision,
            credential:
              item.credential === "configured"
                ? t("models.credOn")
                : t("models.credOff"),
            connection: t("models.connUnknown"),
          })}
        </small>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-grid">
          <label>
            {t("models.provider")}
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setCredential("");
              }}
            >
              {["ollama", "openai", "anthropic", "openrouter"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            {t("models.modelId")}
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
              maxLength={200}
              placeholder={t("models.modelPh")}
            />
          </label>
          <label>
            {t("models.baseUrl")}
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                provider === "ollama"
                  ? "http://127.0.0.1:11434/v1"
                  : t("models.defaultAddrPh")
              }
            />
          </label>
          <label>
            {t("models.tokenLimit")}
            <input
              type="number"
              min={64}
              max={32768}
              value={tokens}
              onChange={(e) => setTokens(Number(e.target.value))}
            />
          </label>
          <label>
            {t("models.newKey")}
            <input
              type="password"
              autoComplete="new-password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={t("models.keyPh")}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
            />{" "}
            {t("models.allowPaidLabel")}
          </label>
        </div>
        <button className="primary" disabled={busy}>
          {busy ? t("models.saving") : t("models.saveProfile")}
        </button>
        <ErrorNotice message={error} />
      </form>
    </section>
  );
}
