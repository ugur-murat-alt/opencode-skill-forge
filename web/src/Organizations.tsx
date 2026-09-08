import { useState, type FormEvent } from "react";
import { api } from "./api";
import { useResource, ErrorNotice, Empty, Refresh, date } from "./ui";

interface Tenant {
  tenant_id: string;
  user_id: string;
  role: string;
  disabled: number;
  name: string;
}
interface Offer {
  id: string;
  to_user_id: string;
  created_by: string;
  expires_at: number;
  accepted_at: number | null;
  created_at: number;
}

export function Organizations({
  userId,
  onSwitch,
}: {
  userId: string;
  onSwitch: () => void;
}) {
  const tenants = useResource<Tenant[]>("/api/tenants");
  const offers = useResource<Offer[]>("/api/organization/transfer/offers");
  const deletion = useResource<{ requested: boolean; requested_at?: number }>(
    "/api/organization/deletion/status",
  );
  const [name, setName] = useState("");
  const [toUser, setToUser] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await Promise.all([
        tenants.refresh(),
        offers.refresh(),
        deletion.refresh(),
      ]);
      onSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "İşlem tamamlanamadı.");
    } finally {
      setBusy(false);
    }
  }
  function create(e: FormEvent) {
    e.preventDefault();
    void run(() =>
      api("/api/organizations", {
        method: "POST",
        body: JSON.stringify({ name }),
      }).then(() => setName("")),
    );
  }
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Organizasyonlar</h1>
          <p className="subtitle">Kur, seç, devret, gerektiğinde sil.</p>
        </div>
        <Refresh run={() => void tenants.refresh()} loading={busy} />
      </div>
      <ErrorNotice message={error || tenants.error} />
      <section className="panel">
        <h2>Kur</h2>
        <form className="toolbar" onSubmit={create}>
          <label>
            Organizasyon adı
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            Kur
          </button>
        </form>
      </section>
      <section className="panel table-panel">
        <h2>Üyeliklerim</h2>
        <table>
          <thead>
            <tr>
              <th>Ad</th>
              <th>Rol</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(tenants.data ?? []).map((t) => (
              <tr key={t.tenant_id}>
                <td>{t.name}</td>
                <td>{t.role}</td>
                <td>
                  <button
                    className="link-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api("/api/tenants/switch", {
                          method: "POST",
                          body: JSON.stringify({ tenant_id: t.tenant_id }),
                        }),
                      )
                    }
                  >
                    Seç
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!tenants.error && !tenants.data?.length && (
          <Empty title="Üyelik yok" />
        )}
      </section>
      <section className="panel">
        <h2>Kurucu devri</h2>
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              api("/api/organization/transfer", {
                method: "POST",
                body: JSON.stringify({ to_user_id: toUser }),
              }).then(() => setToUser("")),
            );
          }}
        >
          <label>
            Alıcı kullanıcı kimliği
            <input
              value={toUser}
              onChange={(e) => setToUser(e.target.value)}
              required
            />
          </label>
          <button disabled={busy}>Teklif et</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Teklif</th>
              <th>Alıcı</th>
              <th>Bitiş</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(offers.data ?? []).map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.id.slice(0, 8)}</td>
                <td className="mono">{o.to_user_id.slice(0, 12)}</td>
                <td>{date(o.expires_at)}</td>
                <td>
                  {o.to_user_id === userId && (
                    <button
                      className="link-button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api(`/api/organization/transfer/${o.id}/accept`, {
                            method: "POST",
                          }),
                        )
                      }
                    >
                      Kabul et
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>Silme</h2>
        {deletion.data?.requested ? (
          <>
            <p>Silme istendi. Onay için bekleme süresi dolmalıdır.</p>
            <div className="toolbar">
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api("/api/organization/deletion/confirm", {
                      method: "POST",
                      body: JSON.stringify({ name: confirmName }),
                    }),
                  )
                }
              >
                Onayla
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api("/api/organization/deletion/cancel", {
                      method: "POST",
                    }),
                  )
                }
              >
                Vazgeç
              </button>
              <label>
                Ad doğrulama
                <input
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                />
              </label>
            </div>
          </>
        ) : (
          <form
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                api("/api/organization/deletion/request", {
                  method: "POST",
                  body: JSON.stringify({ name: confirmName }),
                }),
              );
            }}
          >
            <label>
              Ad doğrulama
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                required
              />
            </label>
            <button disabled={busy}>Silme iste</button>
          </form>
        )}
      </section>
    </>
  );
}
