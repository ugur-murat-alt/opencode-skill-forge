import { useState } from "react";
import { api } from "./api";
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
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Davetler</h1>
          <p className="subtitle">Tek kullanımlık, süreli katılım davetleri.</p>
        </div>
        <Refresh run={() => void resource.refresh()} />
      </div>
      <ErrorNotice message={error || resource.error} />
      <section className="panel">
        <h2>Oluştur</h2>
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
              .catch((e) =>
                setError(
                  e instanceof Error ? e.message : "Davet oluşturulamadı.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Rol
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="reader">Okuyucu</option>
              <option value="writer">Yazıcı</option>
              <option value="admin">Yönetici</option>
              <option value="auditor">Denetçi</option>
            </select>
          </label>
          <button className="primary" disabled={busy}>
            Davet oluştur
          </button>
        </form>
        {token && (
          <p>
            Davet anahtarı: <code data-testid="invite-token">{token}</code>
          </p>
        )}
      </section>
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Rol</th>
              <th>Bitiş</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(resource.data ?? []).map((inv) => (
              <tr key={inv.id}>
                <td>{inv.role}</td>
                <td>{date(inv.expires_at)}</td>
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
                        .catch((e) =>
                          setError(
                            e instanceof Error ? e.message : "İptal edilemedi.",
                          ),
                        )
                        .finally(() => setBusy(false));
                    }}
                  >
                    İptal et
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!resource.error && !resource.data?.length && !token && (
          <Empty title="Bekleyen davet yok" />
        )}
      </section>
    </>
  );
}
