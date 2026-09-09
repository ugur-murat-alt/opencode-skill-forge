import { useState, type FormEvent } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
export function Login({ onLogin }: { onLogin: () => void }) {
  const { t, err } = useLang();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/pair", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setCode("");
      onLogin();
    } catch (error) {
      setError(errorCode(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">{t("shell.brand")}</div>
      <h1>{t("login.title")}</h1>
      <p>{t("login.detail")}</p>
      <form onSubmit={submit}>
        <label htmlFor="code">{t("login.code")}</label>
        <input
          id="code"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          minLength={20}
        />
        <button className="primary" disabled={busy}>
          {busy ? t("login.signingIn") : t("login.signIn")}
        </button>
        {error && (
          <p role="alert" className="error">
            {err(error)}
          </p>
        )}
      </form>
      <a href="/auth/start">{t("login.sso")}</a>
    </main>
  );
}
