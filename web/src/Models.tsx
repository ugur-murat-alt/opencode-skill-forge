import { useState } from "react";
import { api } from "./api";
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
  const profiles = useResource<{ items: Profile[] }>("/api/providers"),
    policy = useResource<{
      values: Record<string, any>;
      sources: Record<string, string>;
    }>(`/api/settings/effective?project_ref=${encodeURIComponent(project)}`);
  return (
    <>
      <h1>Modeller ve tüketim</h1>
      <p className="subtitle">
        Editör, skill geliştirme ve değerlendirme için ayrı model profilleri.
      </p>
      <ErrorNotice message={profiles.error || policy.error} />
      <div className="policy-strip">
        <span>
          Ücretli çağrılar:{" "}
          <strong>{policy.data?.values.allowPaid ? "İzinli" : "Kapalı"}</strong>
        </span>
        <span>
          Maliyet üst sınırı:{" "}
          <strong>
            {policy.data ? money(policy.data.values.maxCostMicros) : "—"}
          </strong>
        </span>
        <span>
          Tur sınırı: <strong>{policy.data?.values.maxCalls ?? "—"}</strong>
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
        <h2>Etkin sağlayıcı sınırları</h2>
        <p>
          Profil kaydı bağlantı başarısı değildir. Sadece yönetici
          politikasındaki origin’lere ve yapılandırılmış bütçeye izin verilir.
        </p>
        <table>
          <thead>
            <tr>
              <th>Ayar</th>
              <th>Değer</th>
              <th>Kaynak</th>
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
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>
          {item.role === "prompt"
            ? "Prompt Editor"
            : item.role === "skill"
              ? "Skill geliştirme"
              : "Değerlendirme"}
        </h2>
        <small>
          Sürüm {item.revision} · Anahtar{" "}
          {item.credential === "configured" ? "kayıtlı" : "yok"} · Bağlantı
          bilinmiyor
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
            Sağlayıcı
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
            Model kimliği
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
              maxLength={200}
              placeholder="Yüklü veya katalogdaki model"
            />
          </label>
          <label>
            Base URL (isteğe bağlı)
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                provider === "ollama"
                  ? "http://127.0.0.1:11434/v1"
                  : "Varsayılan sağlayıcı adresi"
              }
            />
          </label>
          <label>
            Çıktı token sınırı
            <input
              type="number"
              min={64}
              max={32768}
              value={tokens}
              onChange={(e) => setTokens(Number(e.target.value))}
            />
          </label>
          <label>
            Yeni API anahtarı
            <input
              type="password"
              autoComplete="new-password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder="Boş bırakılırsa kayıtlı anahtar korunur"
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
            />{" "}
            Bu profil ücretli çağrı kullanabilir
          </label>
        </div>
        <button className="primary" disabled={busy}>
          {busy ? "Kaydediliyor…" : "Profili kaydet"}
        </button>
        <ErrorNotice message={error} />
      </form>
    </section>
  );
}
