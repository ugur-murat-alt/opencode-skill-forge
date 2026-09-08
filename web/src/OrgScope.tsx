import { useEffect, useState } from "react";
import { api } from "./api";
import { useResource, ErrorNotice } from "./ui";

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
  const tenants = useResource<Tenant[]>("/api/tenants");
  const envs = useResource<Environment[]>("/api/environments");
  const [error, setError] = useState("");
  useEffect(() => {
    void tenants.refresh();
    void envs.refresh();
  }, [tenantId, tick]);
  const current = tenants.data?.find((t) => t.tenant_id === tenantId);
  const projectRow = projects.find((p) => p.id === project);
  const envName =
    envs.data?.find((e) => e.id === projectRow?.environment_id)?.name ??
    (projectRow ? "varsayılan" : "—");
  async function switchTenant(id: string) {
    if (!id || id === tenantId) return;
    setError("");
    try {
      await api("/api/tenants/switch", {
        method: "POST",
        body: JSON.stringify({ tenant_id: id }),
      });
      onSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Geçiş yapılamadı.");
    }
  }
  return (
    <div className="scope-bar">
      <label className="tenant-switch">
        <span className="sr-only">Organizasyon</span>
        <select
          data-testid="tenant-switch"
          value={tenantId}
          onChange={(e) => void switchTenant(e.target.value)}
        >
          {(tenants.data ?? []).map((t) => (
            <option value={t.tenant_id} key={t.tenant_id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <span className="scope-badge" data-testid="scope-badge">
        {current?.name ?? tenantId} • {envName} •{" "}
        {projectRow?.name ?? "proje yok"}
      </span>
      <label className="project-switcher">
        <span className="sr-only">Etkin proje</span>
        <select value={project} onChange={(e) => onProject(e.target.value)}>
          {!projects.length && <option value="">Proje seçin</option>}
          {projects.map((item) => (
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
