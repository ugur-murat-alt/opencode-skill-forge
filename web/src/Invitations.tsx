import { useState } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
import { useResource, ErrorNotice, Empty, Refresh, date } from "./ui";

interface Invitation {
  id: string;
  role: string;
  invited_by: string;
  expires_at: number;
  accepted_at: number | null;
  revoked: number;
  created_at: number;
}

export function Invitations() {
  const resource = useResource<Invitation[]>("/api/invitations");
  const [role, setRole] = useState("reader");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { t, lang } = useLang();
  return (
    <>
      <div className="title-row">
        <div>
          <h1>{t("invites.title")}</h1>
          <p className="subtitle">{t("invites.subtitle")}</p>
        </div>
        <Refresh run={() => void resource.refresh()} />
      </div>
      <ErrorNotice message={error || resource.error} />
      <section className="panel">
        <h2>{t("invites.create")}</h2>
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setToken("");
            void api("/api/invitations", {
              method: "POST",
              body: JSON.stringify({ role }),
            })
              .then((v: any) => {
                setToken(v.token ?? "");
                return resource.refresh();
              })
              .catch((e) => setError(errorCode(e)))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            {t("invites.role")}
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="reader">{t("invites.roleReader")}</option>
              <option value="writer">{t("invites.roleWriter")}</option>
              <option value="admin">{t("invites.roleAdmin")}</option>
              <option value="auditor">{t("invites.roleAuditor")}</option>
            </select>
          </label>
          <button className="primary" disabled={busy}>
            {t("invites.createBtn")}
          </button>
        </form>
        {token && (
          <p>
            {t("invites.tokenLabel")}{" "}
            <code data-testid="invite-token">{token}</code>
          </p>
        )}
      </section>
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>{t("invites.role")}</th>
              <th>{t("invites.expiry")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(resource.data ?? []).map((inv) => (
              <tr key={inv.id}>
                <td>{inv.role}</td>
                <td>{date(inv.expires_at, lang)}</td>
                <td>
                  <button
                    className="link-button"
                    data-testid="invite-revoke"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError("");
                      void api(`/api/invitations/${inv.id}/revoke`, {
                        method: "POST",
                      })
                        .then(() => {
                          setToken("");
                          return resource.refresh();
                        })
                        .catch((e) => setError(errorCode(e)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {t("common.revoke")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!resource.error && !resource.data?.length && !token && (
          <Empty title={t("invites.empty")} />
        )}
      </section>
    </>
  );
}
