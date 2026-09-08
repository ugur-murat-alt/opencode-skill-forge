import { useState, type FormEvent } from "react";
import { api } from "./api";
import { useResource, ErrorNotice, Refresh } from "./ui";
type Member = {
  user_id: string;
  display_name: string;
  role: string;
  disabled: number;
  generation: number;
  project_role: string | null;
  project_generation: number | null;
};
export function Members({ project }: { project: string }) {
  const [after, setAfter] = useState(""),
    [subject, setSubject] = useState(""),
    [name, setName] = useState(""),
    [role, setRole] = useState("reader"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const resource = useResource<{ items: Member[]; next: string | null }>(
    `/api/members?project_ref=${encodeURIComponent(project)}&after=${encodeURIComponent(after)}`,
  );
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/members", {
        method: "POST",
        body: JSON.stringify({ subject, display_name: name, role }),
      });
      setSubject("");
      setName("");
      setAfter("");
      await resource.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Kullanıcılar ve proje erişimi</h2>
        <Refresh run={resource.refresh} loading={resource.loading} />
      </div>
      <p>
        Yönetici bütün projelere erişir. Editör ve görüntüleyici için proje
        üyeliği gerekir. Çalışma alanı görüntüleyicisi proje rolüyle yazma
        yetkisi kazanamaz. Devre dışı üyeliğin mevcut oturumları da erişim
        alamaz.
      </p>
      <ErrorNotice message={error || resource.error} />
      <details>
        <summary>Kullanıcı erişimi tanımla</summary>
        <p>
          Sunucu profilinde kimlik sağlayıcının tam <code>issuer|sub</code>{" "}
          değerini kullanın. Bu işlem davet göndermez veya yeni parola
          oluşturmaz.
        </p>
        <form onSubmit={create}>
          <div className="form-grid">
            <label>
              Kimlik sağlayıcı subject
              <input
                required
                maxLength={1000}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
            <label>
              Görünen ad
              <input
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Çalışma alanı rolü
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="reader">Okuyucu</option>
                <option value="writer">Yazıcı</option>
                <option value="admin">Yönetici</option>
                <option value="auditor">Denetçi</option>
              </select>
            </label>
          </div>
          <button disabled={busy}>Kullanıcıyı ekle</button>
        </form>
      </details>
      <div className="table-panel">
        <table>
          <thead>
            <tr>
              <th>Kullanıcı</th>
              <th>Çalışma alanı</th>
              <th>Bu proje</th>
              <th>Durum</th>
              <th>İşlem</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.items.map((m) => (
              <MemberRow
                key={`${m.user_id}:${m.generation}:${m.project_generation}`}
                member={m}
                project={project}
                refresh={resource.refresh}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="toolbar">
        <button disabled={!after} onClick={() => setAfter("")}>
          İlk sayfa
        </button>
        <button
          disabled={!resource.data?.next}
          onClick={() => setAfter(resource.data!.next!)}
        >
          Sonraki 50 üye
        </button>
      </div>
    </section>
  );
}
function MemberRow({
  member: m,
  project,
  refresh,
}: {
  member: Member;
  project: string;
  refresh: () => Promise<void>;
}) {
  const [role, setRole] = useState(m.role),
    [projectRole, setProjectRole] = useState(m.project_role ?? ""),
    [disabled, setDisabled] = useState(!!m.disabled),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/members/${encodeURIComponent(m.user_id)}`, {
        method: "PUT",
        body: JSON.stringify({
          project_ref: project,
          generation: m.generation,
          project_generation: m.project_generation,
          role,
          project_role: projectRole || null,
          disabled,
        }),
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (m.role === "founder")
    return (
      <tr>
        <td>{m.display_name}</td>
        <td>Kurucu</td>
        <td>Tüm projeler</td>
        <td>Aktif</td>
        <td>Kurucu erişimi korunur</td>
      </tr>
    );
  return (
    <tr>
      <td>
        {m.display_name}
        <small className="block mono">{m.user_id.slice(0, 12)}</small>
      </td>
      <td>
        <select
          aria-label={`${m.display_name} çalışma alanı rolü`}
          value={role}
          disabled={busy}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="reader">Okuyucu</option>
          <option value="writer">Yazıcı</option>
          <option value="admin">Yönetici</option>
          <option value="auditor">Denetçi</option>
        </select>
      </td>
      <td>
        <select
          aria-label={`${m.display_name} proje rolü`}
          value={projectRole}
          disabled={busy || role === "admin"}
          onChange={(e) => setProjectRole(e.target.value)}
        >
          <option value="">Üyelik yok</option>
          <option value="reader">Okuyucu</option>
          <option value="writer">Yazıcı</option>
        </select>
        {role === "admin" && (
          <small className="block">Yönetici olarak erişir</small>
        )}
      </td>
      <td>
        <label>
          <input
            type="checkbox"
            checked={disabled}
            disabled={busy}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          Devre dışı
        </label>
      </td>
      <td>
        <button disabled={busy} onClick={() => void save()}>
          Kaydet
        </button>
        <ErrorNotice message={error} />
      </td>
    </tr>
  );
}
