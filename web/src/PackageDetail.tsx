import { ExecutionView } from "./ExecutionView";
import { useEffect, useRef, useState } from "react";
import { Download, Play, Save, FilePlus, Trash2 } from "lucide-react";
import { api } from "./api";
import { useResource, ErrorNotice, date } from "./ui";
type Skill = {
  skill_id: string;
  name: string;
  revision: string;
  updated_at: number;
  pinned: boolean;
  protected: boolean;
  managed: boolean;
};
type FileInfo = { path: string; hash: string; bytes: number };
type Manifest = {
  files: FileInfo[];
  next: number | null;
  file_count: number;
  execution: {
    entrypoints: Record<
      string,
      { inputSchema: unknown; outputSchema: unknown; tests: { name: string }[] }
    >;
  } | null;
  validation: unknown;
};
type Loaded = {
  content: string;
  encoding: string;
  next_cursor: string | null;
  total_bytes: number;
};
type Change = {
  path: string;
  original_hash: string | null;
  content: string | null;
};
export function PackageDetail({
  skill,
  project,
  close,
  refresh,
}: {
  skill: Skill;
  project: string;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [revision, setRevision] = useState(skill.revision),
    [path, setPath] = useState("SKILL.md"),
    [loaded, setLoaded] = useState<Loaded | null>(null),
    [draft, setDraft] = useState(""),
    [changes, setChanges] = useState<Change[]>([]),
    [rebase, setRebase] = useState(false),
    [newPath, setNewPath] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [entry, setEntry] = useState(""),
    [args, setArgs] = useState("{}"),
    [execution, setExecution] = useState<any>(null);
  const generation = useRef(0),
    revisions = useResource<{
      items: {
        revision: string;
        created_at: number;
        validation_passed: boolean;
      }[];
    }>(`/api/skills/${skill.skill_id}/revisions`),
    manifest = useResource<Manifest>(
      `/api/skills/${skill.skill_id}/manifest?revision=${revision}`,
    );
  useEffect(() => {
    setLoaded(null);
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [revision, path]);
  async function load(cursor?: string) {
    const token = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const value = await api<Loaded>("/api/tools/forge_load", {
        method: "POST",
        body: JSON.stringify({
          project_ref: project,
          skill_id: skill.skill_id,
          revision,
          path,
          cursor,
        }),
      });
      if (token !== generation.current) return;
      const next = cursor
        ? { ...value, content: (loaded?.content ?? "") + value.content }
        : value;
      setLoaded(next);
      setDraft(changes.find((c) => c.path === path)?.content ?? next.content);
    } catch (e) {
      if (token === generation.current) setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function moreFiles() {
    try {
      const next = await api<Manifest>(
        `/api/skills/${skill.skill_id}/manifest?revision=${revision}&after=${manifest.data!.next}`,
      );
      manifest.setData({
        ...next,
        files: [...manifest.data!.files, ...next.files],
      });
    } catch (e) {
      setError(String(e));
    }
  }
  function stage(content: string | null) {
    const hash = manifest.data?.files.find((f) => f.path === path)?.hash;
    if (!hash) {
      setError("Dosya envanterini yükleyin.");
      return;
    }
    setChanges([
      ...changes.filter((c) => c.path !== path),
      { path, original_hash: hash, content },
    ]);
  }
  async function publish() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/skills/${skill.skill_id}/edit`, {
        method: "POST",
        body: JSON.stringify({
          base_revision: skill.revision,
          changes,
          rebase,
        }),
      });
      await refresh();
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function configure(key: string, value: boolean) {
    setBusy(true);
    try {
      await api(`/api/skills/${skill.skill_id}`, {
        method: "PUT",
        body: JSON.stringify({
          base_revision: skill.revision,
          base_updated_at: skill.updated_at,
          [key]: value,
        }),
      });
      await refresh();
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function rollback() {
    setBusy(true);
    try {
      await api(`/api/skills/${skill.skill_id}/rollback`, {
        method: "POST",
        body: JSON.stringify({
          base_revision: skill.revision,
          target_revision: revision,
        }),
      });
      await refresh();
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    setBusy(true);
    setError("");
    setExecution(null);
    try {
      setExecution(
        await api("/api/tools/forge_run", {
          method: "POST",
          body: JSON.stringify({
            project_ref: project,
            skill_id: skill.skill_id,
            revision,
            entrypoint: entry,
            args: JSON.parse(args),
            idempotency_key: crypto.randomUUID(),
          }),
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const editable =
    revision === skill.revision &&
    !skill.pinned &&
    !skill.protected &&
    skill.managed;
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{skill.name}</h2>
        <button disabled={busy} onClick={close}>
          Kapat
        </button>
      </div>
      <ErrorNotice message={error || revisions.error || manifest.error} />
      <div className="toolbar">
        <label>
          Sürüm
          <select
            value={revision}
            disabled={busy || changes.length > 0}
            onChange={(e) => setRevision(e.target.value)}
          >
            {revisions.data?.items.map((row) => (
              <option key={row.revision} value={row.revision}>
                {row.revision.slice(0, 10)} · {date(row.created_at)} ·{" "}
                {row.validation_passed ? "Doğrulandı" : "Doğrulanmadı"}
              </option>
            ))}
          </select>
        </label>
        <a
          className="button"
          href={`/api/skills/${skill.skill_id}/export?revision=${revision}`}
        >
          <Download size={16} />
          ZIP indir
        </a>
        <button
          disabled={busy || revision === skill.revision}
          onClick={() => void rollback()}
        >
          Seçili sürüme dön
        </button>
      </div>
      <div className="file-list" aria-label="Paket dosyaları">
        {manifest.data?.files.map((f) => (
          <button
            key={f.path}
            disabled={busy}
            aria-pressed={path === f.path}
            onClick={() => setPath(f.path)}
          >
            {f.path} <small>{f.bytes} B</small>
          </button>
        ))}
        {manifest.data?.next !== null && manifest.data?.next !== undefined && (
          <button onClick={() => void moreFiles()}>Diğer dosyalar</button>
        )}
      </div>
      <div className="toolbar">
        <strong className="mono">{path}</strong>
        <button disabled={busy} onClick={() => void load()}>
          Dosyayı oku
        </button>
        {loaded?.next_cursor && (
          <button
            disabled={busy}
            onClick={() => void load(loaded.next_cursor!)}
          >
            Devamını yükle
          </button>
        )}
      </div>
      {loaded && (
        <>
          <pre className="code-view">{loaded.content}</pre>
          <small>
            {loaded.encoding === "base64"
              ? "Binary dosya · base64"
              : "UTF-8 metin"}{" "}
            · {loaded.total_bytes} byte{" "}
            {loaded.next_cursor ? "· Kısmi içerik" : "· Tam içerik"}
          </small>
          {editable && loaded.encoding === "utf8" && !loaded.next_cursor && (
            <>
              <label>
                Dosyayı düzenle
                <textarea
                  className="code-editor"
                  rows={12}
                  value={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
              <div className="toolbar">
                <button
                  disabled={busy || changes.length >= 16}
                  onClick={() => stage(draft)}
                >
                  Değişikliği adaya ekle
                </button>
                <button
                  disabled={busy || path === "SKILL.md"}
                  onClick={() => stage(null)}
                >
                  <Trash2 size={16} />
                  Dosya silmeyi adaya ekle
                </button>
              </div>
            </>
          )}
        </>
      )}
      {editable && (
        <>
          <details>
            <summary>
              <FilePlus size={16} />
              Yeni metin dosyası ekle
            </summary>
            <p>
              En fazla 16 dosya tek adayda değişebilir. Referans ve script
              sözleşmelerini aynı adayda güncelleyin.
            </p>
            <label>
              Yeni dosya yolu
              <input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="references/example.md"
              />
            </label>
            <button
              disabled={busy || changes.length >= 16 || !newPath}
              onClick={() => {
                if (
                  manifest.data?.next !== null ||
                  manifest.data.files.some((f) => f.path === newPath) ||
                  changes.some((c) => c.path === newPath)
                ) {
                  setError(
                    "Envanter tamamlanmalı ve yeni dosya adı benzersiz olmalı.",
                  );
                  return;
                }
                setChanges([
                  ...changes,
                  { path: newPath, original_hash: null, content: "" },
                ]);
                setNewPath("");
              }}
            >
              Dosya taslağı ekle
            </button>
          </details>
          {changes.length > 0 && (
            <div className="candidate-panel">
              <h3>Yayın adayı · {changes.length} dosya</h3>
              {changes.map((c) => (
                <details key={c.path} open>
                  <summary>
                    {c.path} ·{" "}
                    {c.content === null
                      ? "Silinecek"
                      : c.original_hash
                        ? "Değişecek"
                        : "Eklenecek"}
                  </summary>
                  {c.content !== null && (
                    <label>
                      Aday içerik
                      <textarea
                        className="code-editor"
                        rows={6}
                        value={c.content}
                        onChange={(e) =>
                          setChanges(
                            changes.map((item) =>
                              item.path === c.path
                                ? { ...item, content: e.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      setChanges(changes.filter((item) => item.path !== c.path))
                    }
                  >
                    Bu değişikliği çıkar
                  </button>
                </details>
              ))}
              <p>
                Yayın bütün paketi doğrular ve kayıtlı script testlerini sandbox
                içinde çalıştırır. Çatışmada aktif sürümün üzerine yazılmaz.
              </p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={rebase}
                  disabled={busy}
                  onChange={(event) => setRebase(event.target.checked)}
                />{" "}
                Çakışmayan dosya değişikliklerini güncel sürümle birleştir
              </label>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void publish()}
              >
                <Save size={16} />
                {busy ? "Doğrulanıyor…" : "Test et ve yayımla"}
              </button>
            </div>
          )}
        </>
      )}
      <FileComparison
        project={project}
        skillId={skill.skill_id}
        revision={revision}
        path={path}
        revisions={revisions.data?.items.map((r) => r.revision) ?? []}
      />
      <details>
        <summary>Bu sürümün doğrulama kanıtı</summary>
        <pre>{JSON.stringify(manifest.data?.validation ?? null, null, 2)}</pre>
      </details>
      {manifest.data?.execution && (
        <details>
          <summary>
            <Play size={16} />
            Kayıtlı script çalıştır
          </summary>
          <label>
            Giriş
            <select value={entry} onChange={(e) => setEntry(e.target.value)}>
              <option value="">Giriş seçin</option>
              {Object.keys(manifest.data.execution.entrypoints).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          {entry && (
            <>
              <details>
                <summary>Girdi ve çıktı şeması</summary>
                <pre>
                  {JSON.stringify(
                    manifest.data.execution.entrypoints[entry],
                    null,
                    2,
                  )}
                </pre>
              </details>
              <label>
                JSON girdi
                <textarea
                  className="code-editor"
                  rows={5}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <button disabled={busy} onClick={() => void run()}>
                Sandbox içinde çalıştır
              </button>
            </>
          )}
          {execution && (
            <ExecutionView
              key={execution.execution_id}
              initial={execution}
              project={project}
            />
          )}
        </details>
      )}
      <div className="toolbar">
        <button
          disabled={busy}
          onClick={() => void configure("pinned", !skill.pinned)}
        >
          {skill.pinned ? "Sabitlemeyi kaldır" : "Sürümü sabitle"}
        </button>
        <button
          disabled={busy}
          onClick={() => void configure("protected", !skill.protected)}
        >
          {skill.protected ? "Korumayı kaldır" : "Paketi koru"}
        </button>
        <button
          disabled={busy}
          onClick={() => void configure("managed", !skill.managed)}
        >
          {skill.managed ? "Otomatik yönetimi kapat" : "Otomatik yönetimi aç"}
        </button>
        <a className="button" href="#maintenance">
          Bakım ve arşivleme
        </a>
      </div>
    </section>
  );
}

function FileComparison({
  project,
  skillId,
  revision,
  path,
  revisions,
}: {
  project: string;
  skillId: string;
  revision: string;
  path: string;
  revisions: string[];
}) {
  const [other, setOther] = useState(""),
    [comparison, setComparison] = useState<{
      left: Loaded | null;
      right: Loaded | null;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    setComparison(null);
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [revision, path, other]);
  async function compare() {
    const token = ++generation.current;
    setBusy(true);
    setError("");
    const read = async (selected: string) => {
      try {
        return await api<Loaded>("/api/tools/forge_load", {
          method: "POST",
          body: JSON.stringify({
            project_ref: project,
            skill_id: skillId,
            revision: selected,
            path,
          }),
        });
      } catch (e) {
        if (e instanceof Error && "status" in e && e.status === 404)
          return null;
        throw e;
      }
    };
    try {
      const [left, right] = await Promise.all([read(other), read(revision)]);
      if (generation.current === token) setComparison({ left, right });
    } catch (e) {
      if (generation.current === token) setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Dosyanın sürümlerini karşılaştır</summary>
      <label>
        Karşılaştırılacak sürüm
        <select
          value={other}
          disabled={busy}
          onChange={(e) => setOther(e.target.value)}
        >
          <option value="">Sürüm seçin</option>
          {revisions
            .filter((r) => r !== revision)
            .map((r) => (
              <option key={r} value={r}>
                {r.slice(0, 12)}
              </option>
            ))}
        </select>
      </label>
      <button disabled={busy || !other} onClick={() => void compare()}>
        Karşılaştır
      </button>
      <ErrorNotice message={error} />
      {comparison && (
        <>
          <p>
            {comparison.left?.next_cursor || comparison.right?.next_cursor
              ? "İlk 24 KiB karşılaştırılıyor; dosyanın devamı bu görünümde yok."
              : comparison.left?.content === comparison.right?.content
                ? "Dosya içeriği aynı."
                : "Dosya içeriği farklı; iki sürüm aşağıda."}
          </p>
          <div className="comparison-grid">
            <div>
              <h3>{other.slice(0, 12)}</h3>
              <pre className="code-view">
                {comparison.left?.content ?? "Bu sürümde dosya yok."}
              </pre>
            </div>
            <div>
              <h3>{revision.slice(0, 12)}</h3>
              <pre className="code-view">
                {comparison.right?.content ?? "Bu sürümde dosya yok."}
              </pre>
            </div>
          </div>
        </>
      )}
    </details>
  );
}
