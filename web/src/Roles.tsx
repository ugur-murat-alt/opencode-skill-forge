import { useState, type FormEvent } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
import { useResource, ErrorNotice, Empty, Refresh } from "./ui";

interface Role {
  name: string;
  kind: string;
  base: string | null;
  tools: string[] | null;
  deleted: boolean;
  builtin: boolean;
}

export function Roles() {
  const resource = useResource<Role[]>("/api/roles");
  const [name, setName] = useState("");
  const [base, setBase] = useState("reader");
  const [tools, setTools] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { t } = useLang();
  function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    void api("/api/roles", {
      method: "POST",
      body: JSON.stringify({
        name,
        base,
        ...(tools.trim()
          ? {
              tools: tools
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            }
          : {}),
      }),
    })
      .then(() => {
        setName("");
        setTools("");
        return resource.refresh();
      })
      .catch((e) => setError(errorCode(e)))
      .finally(() => setBusy(false));
  }
  function mutate(path: string, init: RequestInit, done?: () => void) {
    setBusy(true);
    setError("");
    void api(path, init)
      .then(() => {
        done?.();
        return resource.refresh();
      })
      .catch((e) => setError(errorCode(e)))
      .finally(() => setBusy(false));
  }
  function RoleRow({ r }: { r: Role }) {
    return (
      <tr key={r.name} data-testid={`role-row-${r.name}`}>
        <td>
          {r.name}
          <small className="description">
            {r.builtin
              ? t("roles.builtinDetail", { base: r.base ?? "" })
              : t("roles.customDetail", { base: r.base ?? "" })}
          </small>
        </td>
        <td>{r.builtin ? t("roles.builtin") : t("roles.custom")}</td>
        <td className="mono">{(r.tools ?? []).join(", ")}</td>
        <td>
          {r.name !== "founder" && (
            <button
              className="link-button"
              disabled={busy}
              onClick={() =>
                mutate(`/api/roles/${encodeURIComponent(r.name)}`, {
                  method: "DELETE",
                })
              }
            >
              {t("common.delete")}
            </button>
          )}
        </td>
      </tr>
    );
  }
  return (
    <>
      <div className="title-row">
        <div>
          <h1>{t("roles.title")}</h1>
          <p className="subtitle">{t("roles.subtitle")}</p>
        </div>
        <Refresh run={() => void resource.refresh()} />
      </div>
      <ErrorNotice message={error || resource.error} />
      <section className="panel">
        <h2>{t("roles.create")}</h2>
        <form className="toolbar" onSubmit={create}>
          <label>
            {t("roles.roleName")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("roles.namePh")}
              pattern="[a-z0-9-]{1,64}"
              required
            />
          </label>
          <label>
            {t("roles.base")}
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="reader">{t("roles.baseReader")}</option>
              <option value="writer">{t("roles.baseWriter")}</option>
              <option value="admin">{t("roles.baseAdmin")}</option>
            </select>
          </label>
          <label>
            {t("roles.tools")}
            <input
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              placeholder={t("roles.toolsPh")}
            />
          </label>
          <button className="primary" disabled={busy}>
            {t("roles.create")}
          </button>
        </form>
      </section>
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>{t("roles.role")}</th>
              <th>{t("roles.kind")}</th>
              <th>{t("roles.toolsCol")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(resource.data ?? [])
              .filter((r) => !r.deleted)
              .map((r) => (
                <RoleRow key={r.name} r={r} />
              ))}
          </tbody>
        </table>
        {!resource.error && !(resource.data ?? []).some((r) => !r.deleted) && (
          <Empty title={t("roles.none")} />
        )}
      </section>
      {(resource.data ?? []).some((r) => r.deleted) && (
        <section className="panel table-panel">
          <h2>{t("roles.deleted")}</h2>
          <table>
            <tbody>
              {(resource.data ?? [])
                .filter((r) => r.deleted)
                .map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td>
                      <button
                        className="link-button"
                        data-testid={`role-restore-${r.name}`}
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            `/api/roles/${encodeURIComponent(r.name)}/restore`,
                            { method: "POST" },
                          )
                        }
                      >
                        {t("common.restore")}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
