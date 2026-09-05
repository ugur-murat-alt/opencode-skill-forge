import { Members } from "./Members";
import { useEffect, useState, type FormEvent } from "react";
import { api, type Project } from "./api";
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
  const projects = useResource<{ items: Project[] }>("/api/projects"),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      await projects.refresh();
      await onChange();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>Projeler ve ayarlar</h1>
      <p className="subtitle">
        Kapsamlar, miras alınan sınırlar ve bağımsız özellik bayrakları.
      </p>
      <ErrorNotice message={error || projects.error} />
      <section className="panel">
        <h2>{admin ? "Yeni proje" : "Yetkili projeler"}</h2>
        {admin && (
          <form className="toolbar" onSubmit={create}>
            <label className="search-field">
              Proje adı
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? "Oluşturuluyor…" : "Proje oluştur"}
            </button>
          </form>
        )}
        {projects.data && (
          <table>
            <thead>
              <tr>
                <th>Proje</th>
                <th>project_ref</th>
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
const numericFields = [
  { key: "maxCalls", label: "En fazla model çağrısı", min: 1, max: 100 },
  { key: "maxTokens", label: "Toplam token sınırı", min: 64, max: 1000000 },
  {
    key: "maxCostMicros",
    label: "Maliyet sınırı (mikro USD)",
    min: 0,
    max: 1000000000,
  },
  { key: "concurrency", label: "Eşzamanlı iş", min: 1, max: 1000 },
  { key: "retentionDays", label: "Saklama süresi (gün)", min: 1, max: 3650 },
];
const booleanFields = [
  { key: "promptEnabled", label: "Prompt Editor" },
  { key: "evolutionEnabled", label: "Skill geliştirme" },
  { key: "autoApply", label: "Hazırlanan metni otomatik kullan" },
  { key: "allowPaid", label: "Ücretli model çağrıları" },
  { key: "dependencyInstall", label: "Kilitli bağımlılık kurulumu" },
];
function Settings({ project, userId }: { project?: string; userId: string }) {
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
      setError(String(error));
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Etkin ayarlar</h2>
        <label>
          Kapsam
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="workspace">Çalışma alanı varsayılanı</option>
            {project && (
              <option value={`project:${project}`}>Seçili proje</option>
            )}
            <option value={`personal:${userId}`}>Kişisel tercih</option>
            <option value="policy">Yönetici politikası</option>
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
                <option value="inherit">Miras al</option>
                <option value="true">Açık</option>
                <option value="false">Kapalı</option>
              </select>
              <small>
                Etkin: {String(effective.data?.values[field.key] ?? "—")}
              </small>
            </label>
          ))}
          <label>
            Editör modu
            <select
              value={values.promptMode ?? "inherit"}
              onChange={(e) =>
                change(
                  "promptMode",
                  e.target.value === "inherit" ? undefined : e.target.value,
                )
              }
            >
              <option value="inherit">Miras al</option>
              <option value="when-needed">Gerektiğinde</option>
              <option value="always">Her istekte</option>
              <option value="off">Kapalı</option>
            </select>
          </label>
          <label>
            Öğrenme
            <select
              value={values.learning ?? "inherit"}
              onChange={(e) =>
                change(
                  "learning",
                  e.target.value === "inherit" ? undefined : e.target.value,
                )
              }
            >
              <option value="inherit">Miras al</option>
              <option value="reusable-only">
                Tekrar kullanılabilir dersler
              </option>
              <option value="off">Kapalı</option>
            </select>
          </label>
          {numericFields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                type="number"
                min={field.min}
                max={field.max}
                placeholder={`Miras: ${effective.data?.values[field.key] ?? "—"}`}
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
            { key: "allowedOrigins", label: "İzinli model origin’leri" },
            {
              key: "scriptAllowedOrigins",
              label: "İzinli script HTTPS origin’leri",
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
                placeholder="Her satıra bir origin; boşsa miras al"
              />
            </label>
          ))}
        </div>
        <button className="primary" disabled={!config.data}>
          Ayarları kaydet
        </button>
        {saved && (
          <span className="saved" role="status">
            Kaydedildi
          </span>
        )}
        <small className="helper">
          Sürüm {config.data?.revision ?? "—"}. Daha dar kapsamlar üst
          harcama/ağ sınırını genişletemez. 1 USD = 1.000.000 mikro USD.
        </small>
      </form>
      <details>
        <summary>Etkin değerler ve kaynakları</summary>
        <table>
          <thead>
            <tr>
              <th>Ayar</th>
              <th>Değer</th>
              <th>Kaynak</th>
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
