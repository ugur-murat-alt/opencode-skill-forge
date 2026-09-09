import { useState, type FormEvent } from "react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
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
  const { t, lang } = useLang();
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
      setError(errorCode(e));
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
          <h1>{t("orgs.title")}</h1>
          <p className="subtitle">{t("orgs.subtitle")}</p>
        </div>
        <Refresh run={() => void tenants.refresh()} loading={busy} />
      </div>
      <ErrorNotice message={error || tenants.error} />
      <section className="panel">
        <h2>{t("orgs.create")}</h2>
        <form className="toolbar" onSubmit={create}>
          <label>
            {t("orgs.orgName")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            {t("orgs.create")}
          </button>
        </form>
      </section>
      <section className="panel table-panel">
        <h2>{t("orgs.memberships")}</h2>
        <table>
          <thead>
            <tr>
              <th>{t("orgs.name")}</th>
              <th>{t("orgs.role")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(tenants.data ?? []).map((row) => (
              <tr key={row.tenant_id}>
                <td>{row.name}</td>
                <td>{row.role}</td>
                <td>
                  <button
                    className="link-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api("/api/tenants/switch", {
                          method: "POST",
                          body: JSON.stringify({ tenant_id: row.tenant_id }),
                        }),
                      )
                    }
                  >
                    {t("common.select")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!tenants.error && !tenants.data?.length && (
          <Empty title={t("orgs.none")} />
        )}
      </section>
      <section className="panel">
        <h2>{t("orgs.transfer")}</h2>
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
            {t("orgs.recipient")}
            <input
              value={toUser}
              onChange={(e) => setToUser(e.target.value)}
              required
            />
          </label>
          <button disabled={busy}>{t("common.offer")}</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>{t("orgs.offer")}</th>
              <th>{t("orgs.to")}</th>
              <th>{t("orgs.expiry")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(offers.data ?? []).map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.id.slice(0, 8)}</td>
                <td className="mono">{o.to_user_id.slice(0, 12)}</td>
                <td>{date(o.expires_at, lang)}</td>
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
                      {t("orgs.accept")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>{t("orgs.deletion")}</h2>
        {deletion.data?.requested ? (
          <>
            <p>{t("orgs.deletionPending")}</p>
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
                {t("orgs.confirm")}
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
                {t("common.cancel")}
              </button>
              <label>
                {t("orgs.confirmName")}
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
              {t("orgs.confirmName")}
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                required
              />
            </label>
            <button disabled={busy}>{t("orgs.requestDeletion")}</button>
          </form>
        )}
      </section>
    </>
  );
}
