import { PackageDetail } from "./PackageDetail";
import { useState } from "react";
import { Upload, BookOpen } from "lucide-react";
import { api } from "./api";
import { useResource, ErrorNotice, Empty } from "./ui";
interface Skill {
  skill_id: string;
  name: string;
  description: string;
  scope: string;
  revision: string;
  updated_at: number;
  managed: boolean;
  pinned: boolean;
  protected: boolean;
}
export function Library({ project }: { project: string }) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [scope, setScope] = useState(""),
    [selected, setSelected] = useState<Skill | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [cursor, setCursor] = useState("");
  const resource = useResource<{ items: Skill[]; next_cursor: string | null }>(
    `/api/skills?project_ref=${encodeURIComponent(project)}&query=${encodeURIComponent(query)}${scope ? `&scope=${scope}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  async function importFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 5 * 1024 * 1024)
        throw Error("ZIP en fazla 5 MiB olabilir.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 16384)
        binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
      await api("/api/skills/import", {
        method: "POST",
        body: JSON.stringify({
          archive: btoa(binary),
          project_ref: project,
          scope: scope || "project",
          base_revision: null,
        }),
      });
      await resource.refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Paket içe aktarılamadı.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Skill kütüphanesi</h1>
          <p className="subtitle">
            Sürümlü paketler, referanslar ve çalışan yardımcılar.
          </p>
        </div>
        <label className="button primary file-button">
          <Upload size={16} />
          {busy ? "Doğrulanıyor…" : "ZIP içe aktar"}
          <input
            type="file"
            accept=".zip"
            disabled={busy}
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
        </label>
      </div>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search);
          setCursor("");
        }}
      >
        <label className="search-field">
          Paket ara
          <input
            placeholder="Yöntem veya tetik sözcüğü"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Kapsam
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setCursor("");
            }}
          >
            <option value="">Tüm yetkili kapsamlar</option>
            <option value="project">Proje</option>
            <option value="personal">Kişisel</option>
            <option value="workspace">Çalışma alanı</option>
          </select>
        </label>
        <button>Ara</button>
      </form>
      <ErrorNotice message={error || resource.error} />
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Paket</th>
              <th>Kapsam</th>
              <th>Sürüm</th>
              <th>Yönetim</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.items.map((skill) => (
              <tr key={skill.skill_id}>
                <td>
                  <button
                    className="link-button"
                    onClick={() => setSelected(skill)}
                  >
                    <BookOpen size={17} />
                    {skill.name}
                  </button>
                  <small className="description">{skill.description}</small>
                </td>
                <td>{skill.scope.split(":")[0]}</td>
                <td className="mono">{skill.revision.slice(0, 10)}</td>
                <td>
                  {skill.protected
                    ? "Korumalı"
                    : skill.pinned
                      ? "Sabit"
                      : skill.managed
                        ? "Yönetiliyor"
                        : "Harici"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {resource.data?.items.length === 0 && (
          <Empty
            title="Henüz skill paketi yok"
            detail="Klasik bir ZIP paketi içe aktarın veya doğrulanmış deneyimi istemcinizden teslim edin."
          />
        )}
        <div className="pagination">
          <button disabled={!cursor} onClick={() => setCursor("")}>
            İlk sayfa
          </button>
          <button
            disabled={!resource.data?.next_cursor}
            onClick={() => setCursor(resource.data!.next_cursor!)}
          >
            Sonraki
          </button>
        </div>
      </section>
      {selected && (
        <PackageDetail
          key={`${selected.skill_id}:${selected.revision}`}
          skill={selected}
          project={project}
          close={() => setSelected(null)}
          refresh={resource.refresh}
        />
      )}
    </>
  );
}
