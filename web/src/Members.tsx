import { useState, type FormEvent } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
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
  const { t } = useLang();
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
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{t("members.title")}</h2>
        <Refresh run={resource.refresh} loading={resource.loading} />
      </div>
      <p>{t("members.intro")}</p>
      <ErrorNotice message={error || resource.error} />
      <details>
        <summary>{t("members.defineAccess")}</summary>
        <p>
          {t("members.definePre")} <code>issuer|sub</code>{" "}
          {t("members.definePost")}
        </p>
        <form onSubmit={create}>
          <div className="form-grid">
            <label>
              {t("members.subjectLabel")}
              <input
                required
                maxLength={1000}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
            <label>
              {t("members.nameLabel")}
              <input
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {t("members.workspaceRole")}
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="reader">{t("members.roleReader")}</option>
                <option value="writer">{t("members.roleWriter")}</option>
                <option value="admin">{t("members.roleAdmin")}</option>
                <option value="auditor">{t("members.roleAuditor")}</option>
              </select>
            </label>
          </div>
          <button disabled={busy}>{t("members.addUser")}</button>
        </form>
      </details>
      <div className="table-panel">
        <table>
          <thead>
            <tr>
              <th>{t("members.thUser")}</th>
              <th>{t("members.thWorkspace")}</th>
              <th>{t("members.thProject")}</th>
              <th>{t("members.thStatus")}</th>
              <th>{t("members.thAction")}</th>
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
          {t("members.firstPage")}
        </button>
        <button
          disabled={!resource.data?.next}
          onClick={() => setAfter(resource.data!.next!)}
        >
          {t("members.next50")}
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
  const { t } = useLang();
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
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  if (m.role === "founder")
    return (
      <tr>
        <td>{m.display_name}</td>
        <td>{t("members.founderRole")}</td>
        <td>{t("members.founderProjects")}</td>
        <td>{t("members.founderActive")}</td>
        <td>{t("members.founderNote")}</td>
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
          aria-label={t("members.wsRoleAria", { name: m.display_name })}
          value={role}
          disabled={busy}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="reader">{t("members.roleReader")}</option>
          <option value="writer">{t("members.roleWriter")}</option>
          <option value="admin">{t("members.roleAdmin")}</option>
          <option value="auditor">{t("members.roleAuditor")}</option>
        </select>
      </td>
      <td>
        <select
          aria-label={t("members.projectRoleAria", { name: m.display_name })}
          value={projectRole}
          disabled={busy || role === "admin"}
          onChange={(e) => setProjectRole(e.target.value)}
        >
          <option value="">{t("members.noMembership")}</option>
          <option value="reader">{t("members.roleReader")}</option>
          <option value="writer">{t("members.roleWriter")}</option>
        </select>
        {role === "admin" && (
          <small className="block">{t("members.adminAccess")}</small>
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
          {t("members.disabledLabel")}
        </label>
      </td>
      <td>
        <button disabled={busy} onClick={() => void save()}>
          {t("common.save")}
        </button>
        <ErrorNotice message={error} />
      </td>
    </tr>
  );
}
