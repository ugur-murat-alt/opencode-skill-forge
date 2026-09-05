import { ImportedRewrites } from "./ImportedRewrites";
import { LessonEditor, type Lesson } from "./LessonEditor";
import { useState } from "react";
import { WandSparkles, Copy } from "lucide-react";
import { api } from "./api";
import { useResource, ErrorNotice, Empty, Status } from "./ui";
export function PromptEditor({ project }: { project: string }) {
  const [original, setOriginal] = useState(""),
    [result, setResult] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [lesson, setLesson] = useState(""),
    [triggers, setTriggers] = useState("");
  const learning = useResource<{
    items: Lesson[];
  }>(`/api/prompts/learning?project_ref=${encodeURIComponent(project)}`);
  const settings = useResource<{
    values: Record<string, any>;
    sources: Record<string, string>;
  }>(`/api/settings/effective?project_ref=${encodeURIComponent(project)}`);
  async function prepare() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const value = await api("/api/tools/forge_prepare", {
        method: "POST",
        body: JSON.stringify({
          project_ref: project,
          original,
          idempotency_key: crypto.randomUUID(),
          wait_ms: 10000,
        }),
      });
      setResult(value);
      await learning.refresh();
    } catch (error) {
      setError(String(error));
      setResult({
        status: "fallback",
        original,
        effective: original,
        reason: "service_unavailable",
      });
    } finally {
      setBusy(false);
    }
  }
  async function saveLesson() {
    try {
      await api("/api/prompts/learning", {
        method: "POST",
        body: JSON.stringify({
          project_ref: project,
          content: lesson,
          triggers,
        }),
      });
      setLesson("");
      setTriggers("");
      await learning.refresh();
    } catch (error) {
      setError(String(error));
    }
  }
  async function remove(id: string) {
    try {
      await api(
        `/api/prompts/learning/${id}?project_ref=${encodeURIComponent(project)}`,
        { method: "DELETE" },
      );
      await learning.refresh();
    } catch (error) {
      setError(String(error));
    }
  }
  return (
    <>
      <h1>Prompt Editor</h1>
      <p className="subtitle">
        Özgün niyeti koruyarak netleştirin. Hata halinde özgün metin kullanılır.
      </p>
      <div className="policy-strip">
        <span>
          Editör:{" "}
          <strong>
            {settings.data?.values.promptEnabled ? "Açık" : "Kapalı"}
          </strong>
        </span>
        <span>
          Mod: <strong>{settings.data?.values.promptMode ?? "—"}</strong>
        </span>
        <span>
          Otomatik kullanım:{" "}
          <strong>{settings.data?.values.autoApply ? "Açık" : "Kapalı"}</strong>
        </span>
        <a href="#projects">Ayarları yönet</a>
      </div>
      <ErrorNotice message={error || settings.error || learning.error} />
      <section className="panel">
        <label htmlFor="original">Özgün istek</label>
        <textarea
          id="original"
          rows={6}
          maxLength={32000}
          value={original}
          onChange={(e) => setOriginal(e.target.value)}
          placeholder="Hedefinizi ve korunacak sınırları yazın…"
        />
        <button
          className="primary"
          disabled={busy || !original.trim()}
          onClick={() => void prepare()}
        >
          <WandSparkles size={16} />
          {busy ? "Hazırlanıyor…" : "İsteği hazırla"}
        </button>
        {result && (
          <div className="prompt-result">
            <div className="section-heading">
              <h2>Hazırlama sonucu</h2>
              <Status value={result.status} />
            </div>
            <div className="diff-columns">
              <div>
                <h3>Değişmez özgün metin</h3>
                <pre>{result.original}</pre>
              </div>
              <div>
                <h3>Kullanılacak metin</h3>
                <pre>{result.effective}</pre>
              </div>
            </div>
            <p>{result.reason}</p>
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(result.effective)
                  .catch(() => setError("Panoya kopyalanamadı."))
              }
            >
              <Copy size={16} /> Metni kopyala
            </button>
            <small className="helper">
              Bu hazırlama, açık istemcide gönderilmiş mesajı değiştirmez.
            </small>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Tekrar kullanılabilir dersler</h2>
        <p>
          Yalnız bu kullanıcı ve yetkili kapsamındaki ilgili dersler seçilerek
          kullanılır.
        </p>
        {learning.data?.items.length ? (
          <ul className="learning-list">
            {learning.data.items.map((item) => (
              <LessonEditor
                key={item.id}
                item={item}
                project={project}
                refresh={learning.refresh}
                remove={() => void remove(item.id)}
              />
            ))}
          </ul>
        ) : (
          <Empty title="Henüz ders yok" />
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveLesson();
          }}
        >
          <label>
            Yeni genel kural
            <textarea
              value={lesson}
              onChange={(e) => setLesson(e.target.value)}
              required
              maxLength={5000}
              rows={2}
            />
          </label>
          <label>
            İlgili sözcükler
            <input
              value={triggers}
              onChange={(e) => setTriggers(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <button>Dersi kaydet</button>
        </form>
      </section>
      <ImportedRewrites key={project} project={project} />
    </>
  );
}
