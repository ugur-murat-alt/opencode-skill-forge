import { PackageDetail } from "./PackageDetail";
import { useEffect, useState } from "react";
import { Upload, BookOpen } from "lucide-react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
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
  score?: number;
  why?: string[];
  other_scopes?: string[];
}
export function Library({
  project,
  tenant,
}: {
  project: string;
  tenant: string;
}) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [scope, setScope] = useState(""),
    [selected, setSelected] = useState<Skill | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [cursor, setCursor] = useState("");
  const { t } = useLang();
  const resource = useResource<{ items: Skill[]; next_cursor: string | null }>(
    `/api/skills?project_ref=${encodeURIComponent(project)}&query=${encodeURIComponent(query)}${scope ? `&scope=${scope}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  // Issue #17: keep the open detail's metadata in sync with the refreshed
  // list (pin/configure operations no longer close the detail).
  useEffect(() => {
    if (!selected) return;
    const fresh = resource.data?.items.find(
      (item) => item.skill_id === selected.skill_id,
    );
    if (fresh && fresh !== selected) setSelected(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.data]);
  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("archive_limit");
      return;
    }
    setBusy(true);
    setError("");
    try {
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
      setError(errorCode(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="title-row">
        <div>
          <h1>{t("library.title")}</h1>
          <p className="subtitle">{t("library.subtitle")}</p>
        </div>
        <label className="button primary file-button">
          <Upload size={16} />
          {busy ? t("library.importing") : t("library.import")}
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
          {t("library.searchLabel")}
          <input
            placeholder={t("library.searchPh")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          {t("library.scope")}
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setCursor("");
            }}
          >
            <option value="">{t("library.allScopes")}</option>
            <option value="project">{t("library.scopeProject")}</option>
            <option value="personal">{t("library.scopePersonal")}</option>
            <option value="workspace">{t("library.scopeWorkspace")}</option>
            <option value="environment">{t("library.scopeEnvironment")}</option>
          </select>
        </label>
        <button>{t("common.search")}</button>
      </form>
      <ErrorNotice message={error || resource.error} />
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>{t("library.colPackage")}</th>
              <th>{t("library.colScope")}</th>
              <th>{t("library.colScore")}</th>
              <th>{t("library.colRevision")}</th>
              <th>{t("library.colManagement")}</th>
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
                  {!!skill.other_scopes?.length && (
                    <small className="description">
                      {t("library.alsoWith", {
                        scopes: skill.other_scopes.join(", "),
                      })}
                    </small>
                  )}
                </td>
                <td>{skill.scope.split(":")[0]}</td>
                <td>
                  {skill.score !== undefined && (
                    <span
                      className="mono"
                      data-testid="skill-score"
                      title={(skill.why ?? []).join(" · ")}
                    >
                      {skill.score.toFixed(3)}
                    </span>
                  )}
                </td>
                <td className="mono">{skill.revision.slice(0, 10)}</td>
                <td>
                  {skill.protected
                    ? t("library.protected")
                    : skill.pinned
                      ? t("library.pinned")
                      : skill.managed
                        ? t("library.managed")
                        : t("library.external")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {resource.data?.items.length === 0 && (
          <Empty
            title={t("library.emptyTitle")}
            detail={t("library.emptyDetail")}
          />
        )}
        <div className="pagination">
          <button disabled={!cursor} onClick={() => setCursor("")}>
            {t("library.firstPage")}
          </button>
          <button
            disabled={!resource.data?.next_cursor}
            onClick={() => setCursor(resource.data!.next_cursor!)}
          >
            {t("library.nextPage")}
          </button>
        </div>
      </section>
      {selected && (
        <PackageDetail
          // Issue #31: the key stays on the package identity. A refreshed
          // active revision updates props instead of remounting the detail,
          // so an in-progress draft survives the list refresh.
          key={selected.skill_id}
          skill={selected}
          project={project}
          tenant={tenant}
          close={() => setSelected(null)}
          refresh={resource.refresh}
        />
      )}
    </>
  );
}
