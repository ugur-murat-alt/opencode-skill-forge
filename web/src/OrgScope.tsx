import { useEffect, useRef, useState } from "react";
import { api, errorCode } from "./api";
import { useResource, ErrorNotice } from "./ui";
import { useLang } from "./i18n/lang";

interface Tenant {
  tenant_id: string;
  user_id: string;
  role: string;
  disabled: number;
  name: string;
}
interface Environment {
  id: string;
  name: string;
}
interface Project {
  id: string;
  name: string;
  environment_id?: string | null;
}

export function OrgScope({
  tenantId,
  project,
  projects,
  onProject,
  onSwitch,
  tick,
  switching,
  error,
}: {
  tenantId: string;
  project: string;
  projects: Project[];
  onProject: (id: string) => void;
  onSwitch: (tenantId: string) => void;
  tick: number;
  switching: boolean;
  error: string;
}) {
  const { t } = useLang();
  const tenants = useResource<Tenant[]>("/api/tenants");
  const envs = useResource<Environment[]>("/api/environments");
  // Issue #29: the selector starts with the first keyset page and only seeks
  // the visible selection (bounded) or loads more on demand, so a large
  // project list no longer drains 50 pages before the first paint.
  const [allProjects, setAllProjects] = useState<Project[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [projectError, setProjectError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const known = useRef(new Map<string, Project>());
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => {
    const request = ++generation.current;
    setAllProjects(null);
    setNext(null);
    setProjectError("");
    setLoadingMore(false);
    known.current = new Map();
    void (async () => {
      try {
        let page = await api<{ items: Project[]; next: string | null }>(
          "/api/projects",
        );
        if (request !== generation.current) return;
        const items: Project[] = [];
        const absorb = (rows: Project[]) => {
          for (const row of rows) {
            if (known.current.has(row.id)) continue;
            known.current.set(row.id, row);
            items.push(row);
          }
        };
        absorb(page.items);
        let cursor = page.next;
        // Resolve the selected project's name even when it lives beyond the
        // first page; stop as soon as it is found.
        const seenCursors = new Set<string>();
        for (
          let i = 0;
          cursor && i < 50 && !known.current.has(projectRef.current);
          i++
        ) {
          if (seenCursors.has(cursor)) break;
          seenCursors.add(cursor);
          page = await api(`/api/projects?after=${encodeURIComponent(cursor)}`);
          if (request !== generation.current) return;
          absorb(page.items);
          cursor = page.next;
        }
        setAllProjects(items);
        setNext(cursor);
      } catch (caught) {
        if (request !== generation.current) return;
        setAllProjects(projects);
        setNext(null);
        setProjectError(errorCode(caught));
      }
    })();
    return () => {
      generation.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, tick]);
  async function loadMoreProjects() {
    const cursor = next;
    if (!cursor || loadingMore) return;
    const request = generation.current;
    setLoadingMore(true);
    setProjectError("");
    try {
      const page = await api<{ items: Project[]; next: string | null }>(
        `/api/projects?after=${encodeURIComponent(cursor)}`,
      );
      if (request !== generation.current) return;
      const merged = [...(allProjects ?? [])];
      for (const row of page.items) {
        if (known.current.has(row.id)) continue;
        known.current.set(row.id, row);
        merged.push(row);
      }
      setAllProjects(merged);
      setNext(page.next);
    } catch (caught) {
      if (request === generation.current) setProjectError(errorCode(caught));
    } finally {
      if (request === generation.current) setLoadingMore(false);
    }
  }
  useEffect(() => {
    void tenants.refresh();
    void envs.refresh();
  }, [tenantId, tick]);
  const current = tenants.data?.find((tn) => tn.tenant_id === tenantId);
  const selectorProjects = allProjects ?? projects;
  const projectRow = selectorProjects.find((p) => p.id === project);
  const envName =
    envs.data?.find((e) => e.id === projectRow?.environment_id)?.name ??
    (projectRow ? t("scope.defaultEnv") : "—");
  return (
    <div className="scope-bar" aria-busy={switching || undefined}>
      <label className="tenant-switch">
        <span className="sr-only">{t("scope.organization")}</span>
        <select
          data-testid="tenant-switch"
          value={tenantId}
          onChange={(e) => onSwitch(e.target.value)}
        >
          {(tenants.data ?? []).map((tn) => (
            <option value={tn.tenant_id} key={tn.tenant_id}>
              {tn.name}
            </option>
          ))}
        </select>
      </label>
      <span className="scope-badge" data-testid="scope-badge">
        {current?.name ?? tenantId} • {envName} •{" "}
        {projectRow?.name ?? t("scope.noProject")}
      </span>
      <label className="project-switcher">
        <span className="sr-only">{t("scope.activeProject")}</span>
        <select value={project} onChange={(e) => onProject(e.target.value)}>
          {!selectorProjects.length && (
            <option value="">{t("scope.selectProject")}</option>
          )}
          {selectorProjects.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {next !== null && (
        <button
          className="link-button"
          data-testid="projects-load-more"
          disabled={loadingMore || switching}
          onClick={() => void loadMoreProjects()}
        >
          {t("scope.moreProjects")}
        </button>
      )}
      <ErrorNotice
        message={error || projectError || tenants.error || envs.error}
      />
    </div>
  );
}
