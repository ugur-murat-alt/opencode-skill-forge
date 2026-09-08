import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { useResource, ErrorNotice, Empty, Refresh, date } from "./ui";

interface PromptRow {
  version: number;
  created_by: string;
  created_at: number;
}
interface ActiveRow extends PromptRow {
  content: string;
}

export function AgentPrompts() {
  const [scope, setScope] = useState("org");
  const [text, setText] = useState("");
  const [base, setBase] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const envs = useResource<{ id: string; name: string }[]>("/api/environments");
  const resource = useResource<{
    active: ActiveRow | null;
    history: PromptRow[];
  }>(`/api/agent-prompts?scope=${encodeURIComponent(scope)}`);
  function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    void api("/api/agent-prompts", {
      method: "PUT",
      body: JSON.stringify({ scope, base_version: base, content: text }),
    })
      .then(() => resource.refresh())
      .catch((e) => setError(e instanceof Error ? e.message : "Kaydedilemedi."))
      .finally(() => setBusy(false));
  }
  function rollback(version: number) {
    setBusy(true);
    setError("");
    void api("/api/agent-prompts/rollback", {
      method: "POST",
      body: JSON.stringify({ scope, version }),
    })
      .then(() => resource.refresh())
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Geri alınamadı."),
      )
      .finally(() => setBusy(false));
  }
  const active = resource.data?.active;
  useEffect(() => {
    setText(active?.content ?? "");
    setBase(active?.version ?? 0);
  }, [scope, active?.content, active?.version]);
  return (
    <>
      <div className="title-row">
        <div>
          <h1>Ajan promptları</h1>
          <p className="subtitle">
            Sürümlü sistem promptu: ortam kuruluşu ezer.
          </p>
        </div>
        <Refresh run={() => void resource.refresh()} />
      </div>
      <ErrorNotice message={error || resource.error} />
      <section className="panel">
        <div className="toolbar">
          <label>
            Kapsam
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="org">Kuruluş varsayılanı</option>
              {(envs.data ?? []).map((e) => (
                <option value={`environment:${e.id}`} key={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <form onSubmit={save}>
          <label>
            Sistem promptu
            <textarea
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
          </label>
          <p>
            <small>Taban sürüm: v{base}</small>
          </p>
          <button className="primary" disabled={busy}>
            Kaydet
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Etkin sürüm</h2>
        {active ? (
          <pre className="prompt-content">{active.content}</pre>
        ) : (
          <Empty
            title="Kayıtlı sürüm yok"
            detail="Paketlenmiş dosya kullanılır."
          />
        )}
      </section>
      <section className="panel table-panel">
        <h2>Geçmiş</h2>
        <table>
          <thead>
            <tr>
              <th>Sürüm</th>
              <th>Tarih</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(resource.data?.history ?? []).map((h) => (
              <tr key={h.version}>
                <td className="mono">v{h.version}</td>
                <td>{date(h.created_at)}</td>
                <td>
                  <button
                    className="link-button"
                    disabled={busy}
                    onClick={() => rollback(h.version)}
                  >
                    Geri al
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
