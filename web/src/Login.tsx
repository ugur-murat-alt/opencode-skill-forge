import { useState, type FormEvent } from "react";
import { api } from "./api";
export function Login({ onLogin }: { onLogin: () => void }) {
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
      setError(error instanceof Error ? error.message : "Giriş tamamlanamadı.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">Skill Forge</div>
      <h1>Çalışma alanına giriş</h1>
      <p>Yerel servisten aldığınız tek kullanımlık eşleme kodunu girin.</p>
      <form onSubmit={submit}>
        <label htmlFor="code">Eşleme kodu</label>
        <input
          id="code"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          minLength={20}
        />
        <button className="primary" disabled={busy}>
          {busy ? "Giriş yapılıyor…" : "Giriş yap"}
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
      <a href="/auth/start">Kurumsal hesapla giriş</a>
    </main>
  );
}
