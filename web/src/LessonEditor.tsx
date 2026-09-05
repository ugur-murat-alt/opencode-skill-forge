import { useState } from "react";
import { api } from "./api";
import { ErrorNotice } from "./ui";
export type Lesson = {
  id: string;
  content: string;
  trigger_text: string;
  scope_key: string;
  revision: number;
  disabled: number;
};
export function LessonEditor({
  item,
  project,
  refresh,
  remove,
}: {
  item: Lesson;
  project: string;
  refresh: () => Promise<void>;
  remove: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [content, setContent] = useState(item.content),
    [triggers, setTriggers] = useState(item.trigger_text),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<Lesson[] | null>(null);
  async function save(disabled: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/prompts/learning/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          project_ref: project,
          base_revision: item.revision,
          content: editing ? content : item.content,
          triggers: editing ? triggers : item.trigger_text,
          disabled,
        }),
      });
      setEditing(false);
      setHistory(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function loadHistory() {
    setError("");
    try {
      const value = await api<{ items: Lesson[] }>(
        `/api/prompts/learning/${item.id}/history?project_ref=${encodeURIComponent(project)}`,
      );
      setHistory(value.items);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <li>
      <div>
        <p>{item.content}</p>
        <small>
          {item.trigger_text} ·{" "}
          {item.scope_key.startsWith("personal:") ? "Kişisel" : "Proje"} · Sürüm{" "}
          {item.revision} · {item.disabled ? "Devre dışı" : "Etkin"}
        </small>
        <ErrorNotice message={error} />
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(Boolean(item.disabled));
            }}
          >
            <label>
              Ders metni
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={5000}
                required
              />
            </label>
            <label>
              İlgili sözcükler
              <input
                value={triggers}
                onChange={(e) => setTriggers(e.target.value)}
                maxLength={200}
                required
              />
            </label>
            <button disabled={busy}>Değişiklikleri kaydet</button>
            <button type="button" onClick={() => setEditing(false)}>
              Vazgeç
            </button>
          </form>
        )}
        <div className="actions">
          <button
            disabled={busy}
            onClick={() => {
              setContent(item.content);
              setTriggers(item.trigger_text);
              setEditing(true);
            }}
          >
            Düzenle
          </button>
          <button
            disabled={busy || editing}
            onClick={() => void save(!item.disabled)}
          >
            {item.disabled ? "Etkinleştir" : "Devre dışı bırak"}
          </button>
          <button onClick={() => void loadHistory()}>Geçmiş</button>
          <button className="danger" disabled={busy} onClick={remove}>
            Sil
          </button>
        </div>
        {history && (
          <div>
            <p>Son {history.length} sürüm (en fazla 20)</p>
            <ol>
              {history.map((version) => (
                <li key={version.revision}>
                  <div>
                    <strong>
                      Sürüm {version.revision} ·{" "}
                      {version.disabled ? "Devre dışı" : "Etkin"}
                    </strong>
                    <p>{version.content}</p>
                    <small>{version.trigger_text}</small>
                  </div>
                </li>
              ))}
            </ol>
            <button onClick={() => setHistory(null)}>Geçmişi kapat</button>
          </div>
        )}
      </div>
    </li>
  );
}
