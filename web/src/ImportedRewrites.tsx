import { useState } from "react";
import { api } from "./api";
import { useResource, ErrorNotice, Empty } from "./ui";
type Preview = {
  id: string;
  source_ts: number;
  original_preview: string;
  rewritten_preview: string;
  source_applied: boolean | null;
  model: string | null;
  duration_ms: number;
};
export function ImportedRewrites({ project }: { project: string }) {
  const [after, setAfter] = useState(""),
    [detail, setDetail] = useState<{
      original: string;
      rewritten: string;
    } | null>(null),
    [error, setError] = useState("");
  const data = useResource<{ items: Preview[]; next: string | null }>(
    `/api/prompts/imported-rewrites?project_ref=${encodeURIComponent(project)}&after=${after}`,
  );
  async function open(id: string) {
    setError("");
    try {
      const result = await api<{
        record: { original: string; rewritten: string };
      }>(
        `/api/prompts/imported-rewrites/${id}?project_ref=${encodeURIComponent(project)}`,
      );
      setDetail(result.record);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="panel">
      <h2>Aktarılan eski prompt geçmişi</h2>
      <p>
        Eski OpenCode kayıtlarıdır. Yeni servis çalıştırması veya doğrulanmış
        uygulama kanıtı değildir.
      </p>
      <ErrorNotice message={error || data.error} />
      {data.data?.items.length ? (
        <ul className="learning-list">
          {data.data.items.map((item) => (
            <li key={item.id}>
              <div className="imported-rewrite">
                <small>
                  {new Date(item.source_ts).toLocaleString("tr-TR")} ·{" "}
                  {item.model ?? "Model belirtilmemiş"} · Eski uygulama bilgisi:{" "}
                  {item.source_applied === null
                    ? "Bilinmiyor"
                    : item.source_applied
                      ? "Uygulandı olarak kaydedilmiş"
                      : "Uygulanmadı olarak kaydedilmiş"}
                </small>
                <div className="diff-columns">
                  <div>
                    <h3>Özgün metin</h3>
                    <p>{item.original_preview}</p>
                  </div>
                  <div>
                    <h3>Eski düzenlenmiş metin</h3>
                    <p>{item.rewritten_preview}</p>
                  </div>
                </div>
                <button onClick={() => void open(item.id)}>
                  Tam metinleri aç
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="Aktarılmış prompt geçmişi yok" />
      )}
      {after && <button onClick={() => setAfter("")}>İlk sayfa</button>}
      {data.data?.next && (
        <button onClick={() => setAfter(data.data!.next!)}>
          Sonraki 20 kayıt
        </button>
      )}
      {detail && (
        <div>
          <div className="diff-columns">
            <div>
              <h3>Özgün metin</h3>
              <pre>{detail.original}</pre>
            </div>
            <div>
              <h3>Eski düzenlenmiş metin</h3>
              <pre>{detail.rewritten}</pre>
            </div>
          </div>
          <button onClick={() => setDetail(null)}>Metinleri kapat</button>
        </div>
      )}
    </section>
  );
}
