import { useEffect, useState } from "react";
import { api, errorCode, setActiveTenant } from "./api";
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
}: {
  tenantId: string;
  project: string;
  projects: Project[];
  onProject: (id: string) => void;
  onSwitch: () => void;
  tick: number;
}) {
  const { t } = useLang();
  const tenants = useResource<Tenant[]>("/api/tenants");
  const envs = useResource<Environment[]>("/api/environments");
  // Issue #15: the /api/me project list is a bounded summary; the selector
  // follows the /api/projects keyset pages so every authorized project is
  // selectable.
  const [allProjects, setAllProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setAllProjects(null);
    void (async () => {
      try {
        let page = await api<{
          items: Project[];
          next: string | null;
        }>("/api/projects");
        let merged = [...page.items];
        for (let i = 0; i < 50 && page.next; i++) {
          page = await api<{ items: Project[]; next: string | null }>(
            `/api/projects?after=${encodeURIComponent(page.next)}`,
          );
          merged = merged.concat(page.items);
        }
        if (!cancelled) setAllProjects(merged);
      } catch {
        if (!cancelled) setAllProjects(projects);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, tick]);
  const selectorProjects = allProjects ?? projects;
  useEffect(() => {
    void tenants.refresh();
    void envs.refresh();
  }, [tenantId, tick]);
  const current = tenants.data?.find((tn) => tn.tenant_id === tenantId);
  const projectRow = (allProjects ?? projects).find((p) => p.id === project);
  const envName =
    envs.data?.find((e) => e.id === projectRow?.environment_id)?.name ??
    (projectRow ? t("scope.defaultEnv") : "—");
  async function switchTenant(id: string) {
    if (!id || id === tenantId) return;
    setError("");
    // The switch itself must claim the target tenant: after the cookie flips,
    // a stale-tenant /api/me would otherwise pin the screen back (issue #3).
    setActiveTenant(id);
    try {
      await api("/api/tenants/switch", {
        method: "POST",
        body: JSON.stringify({ tenant_id: id }),
      });
      onSwitch();
    } catch (e) {
      setActiveTenant(tenantId);
      setError(errorCode(e));
    }
  }
  return (
    <div className="scope-bar">
      <label className="tenant-switch">
        <span className="sr-only">{t("scope.organization")}</span>
        <select
          data-testid="tenant-switch"
          value={tenantId}
          onChange={(e) => void switchTenant(e.target.value)}
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
      <ErrorNotice message={error || tenants.error || envs.error} />
    </div>
  );
}
