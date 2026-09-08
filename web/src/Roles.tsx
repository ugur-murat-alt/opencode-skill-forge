import { useState, type FormEvent } from "react";
import { api } from "./api";
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
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Rol oluşturulamadı."),
      )
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
      .catch((e) =>
        setError(e instanceof Error ? e.message : "İşlem başarısız."),
      )
      .finally(() => setBusy(false));
  }
  function RoleRow({ r }: { r: Role }) {
    return (
      <tr key={r.name} data-testid={`role-row-${r.name}`}>
        <td>
          {r.name}
          <small className="description">
            {r.builtin ? `yerleşik · ${r.base}` : `özel · taban ${r.base}`}
          </small>
        </td>
        <td>{r.builtin ? "Yerleşik" : "Özel"}</td>
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
              Sil
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
          <h1>Roller</h1>
          <p className="subtitle">Yerleşik roller ve özel araç kümeleri.</p>
        </div>
        <Refresh run={() => void resource.refresh()} />
      </div>
      <ErrorNotice message={error || resource.error} />
      <section className="panel">
        <h2>Oluştur</h2>
        <form className="toolbar" onSubmit={create}>
          <label>
            Rol adı
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ornek-rol"
              pattern="[a-z0-9-]{1,64}"
              required
            />
          </label>
          <label>
            Taban
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              <option value="reader">Okuyucu</option>
              <option value="writer">Yazıcı</option>
              <option value="admin">Yönetici</option>
            </select>
          </label>
          <label>
            Araçlar (virgüllü, boşsa taban)
            <input
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              placeholder="forge_search, forge_report"
            />
          </label>
          <button className="primary" disabled={busy}>
            Oluştur
          </button>
        </form>
      </section>
      <section className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Rol</th>
              <th>Tür</th>
              <th>Araçlar</th>
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
          <Empty title="Rol yok" />
        )}
      </section>
      {(resource.data ?? []).some((r) => r.deleted) && (
        <section className="panel table-panel">
          <h2>Silinmiş</h2>
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
                        Geri yükle
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
