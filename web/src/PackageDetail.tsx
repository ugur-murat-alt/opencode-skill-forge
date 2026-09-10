import { ExecutionView } from "./ExecutionView";
import { useEffect, useRef, useState } from "react";
import { Download, Play, Save, FilePlus, Trash2 } from "lucide-react";
import { api, errorCode } from "./api";
import { useLang } from "./i18n/lang";
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
export type Change = {
  path: string;
  original_hash: string | null;
  content: string | null;
  /** Issue #31: revision the candidate was staged against; stripped before
   * the publish request so the server contract stays unchanged. */
  staged_in?: string;
};
export type DraftScope = {
  tenant: string;
  project: string;
  skillId: string;
};
export type DraftSnapshot = {
  drafts: Record<string, string>;
  bases: Record<string, string>;
  changes: Change[];
  rebase: boolean;
};

// Issue #31: drafts and staged candidates survive unmounting (page, project,
// tenant or package transitions) in a module store, and survive a browser
// refresh through sessionStorage (per tab, never sent to the server). The
// scope key includes the visible tenant, so a draft from one tenant can
// never be applied to another; explicit Kapat/discard clears only its own
// scope.
const DRAFT_STORAGE_PREFIX = "forge-draft:";
const MAX_PERSISTED_BYTES = 128 * 1024;
const draftSnapshots = new Map<string, DraftSnapshot>();

export function draftScopeKey(scope: DraftScope): string {
  return `${scope.tenant}\u0000${scope.project}\u0000${scope.skillId}`;
}
export function draftKeyOf(revision: string, path: string): string {
  return `${revision}:${path}`;
}
export function revisionOfDraftKey(key: string): string {
  const separator = key.indexOf(":");
  return separator === -1 ? "" : key.slice(0, separator);
}
export function pathOfDraftKey(key: string): string {
  const separator = key.indexOf(":");
  return separator === -1 ? key : key.slice(separator + 1);
}
function copySnapshot(snapshot: DraftSnapshot): DraftSnapshot {
  return {
    drafts: { ...snapshot.drafts },
    bases: { ...snapshot.bases },
    changes: snapshot.changes.map((change) => ({ ...change })),
    rebase: snapshot.rebase,
  };
}
function loadPersistedDraft(key: string): DraftSnapshot | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`${DRAFT_STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftSnapshot>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      drafts: parsed.drafts ?? {},
      bases: parsed.bases ?? {},
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      rebase: Boolean(parsed.rebase),
    };
  } catch {
    return null;
  }
}
function persistDraft(key: string, snapshot: DraftSnapshot): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const raw = JSON.stringify(snapshot);
    if (raw.length > MAX_PERSISTED_BYTES) {
      sessionStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${key}`);
      return;
    }
    sessionStorage.setItem(`${DRAFT_STORAGE_PREFIX}${key}`, raw);
  } catch {}
}
function removePersistedDraft(key: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${key}`);
  } catch {}
}
export function writeDraftSnapshot(key: string, snapshot: DraftSnapshot): void {
  if (
    Object.keys(snapshot.drafts).length === 0 &&
    snapshot.changes.length === 0
  ) {
    draftSnapshots.delete(key);
    removePersistedDraft(key);
    return;
  }
  draftSnapshots.set(key, copySnapshot(snapshot));
  persistDraft(key, snapshot);
}
export function readDraftSnapshot(key: string): DraftSnapshot | null {
  let snapshot = draftSnapshots.get(key);
  if (!snapshot) {
    const persisted = loadPersistedDraft(key);
    if (persisted) {
      draftSnapshots.set(key, persisted);
      snapshot = persisted;
    }
  }
  return snapshot ? copySnapshot(snapshot) : null;
}
export function clearDraftSnapshot(key: string): void {
  draftSnapshots.delete(key);
  removePersistedDraft(key);
}
export function stagedContentFor(
  snapshot: Pick<DraftSnapshot, "changes">,
  revision: string,
  path: string,
): string | null | undefined {
  return snapshot.changes.find(
    (change) =>
      change.path === path &&
      (change.staged_in === undefined || change.staged_in === revision),
  )?.content;
}
/** One draft key is dirty when its editor text differs from both the staged
 * candidate and the content the edit started from. */
export function draftDirty(
  snapshot: Pick<DraftSnapshot, "drafts" | "bases" | "changes">,
  revision: string,
  path: string,
): boolean {
  const key = draftKeyOf(revision, path);
  const value = snapshot.drafts[key];
  if (value === undefined) return false;
  const staged = stagedContentFor(snapshot, revision, path);
  if (staged !== undefined && staged === value) return false;
  return snapshot.bases[key] !== value;
}
/** True when any unpublished work exists: staged candidates count even when
 * the editor equals the candidate (stage is not publish), and any file's
 * unsent draft counts even while another file is open. */
export function unpublishedWork(
  snapshot: Pick<DraftSnapshot, "drafts" | "bases" | "changes">,
): boolean {
  if (snapshot.changes.length > 0) return true;
  return Object.entries(snapshot.drafts).some(([key, value]) => {
    const path = pathOfDraftKey(key);
    const revision = revisionOfDraftKey(key);
    const staged = stagedContentFor(snapshot, revision, path);
    if (staged !== undefined && staged === value) return false;
    return snapshot.bases[key] !== value;
  });
}
/** Drafts newer than the staged candidate for the selected revision; these
 * would be lost by publishing the candidate snapshot. */
export function unstagedDraftCount(
  snapshot: Pick<DraftSnapshot, "drafts" | "bases" | "changes">,
  revision: string,
): number {
  return snapshot.changes.reduce((count, change) => {
    const key = draftKeyOf(revision, change.path);
    const value = snapshot.drafts[key];
    if (value === undefined) return count;
    if (value === change.content) return count;
    if (value === snapshot.bases[key]) return count;
    return count + 1;
  }, 0);
}
function omitKeys(
  values: Record<string, string>,
  keys: Set<string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(values))
    if (!keys.has(key)) next[key] = value;
  return next;
}

export function PackageDetail({
  skill,
  project,
  tenant,
  close,
  refresh,
}: {
  skill: Skill;
  project: string;
  tenant: string;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const { t, lang } = useLang();
  const scopeKey = draftScopeKey({
    tenant,
    project,
    skillId: skill.skill_id,
  });
  const storedState = useState<DraftSnapshot | null>(() =>
    readDraftSnapshot(scopeKey),
  )[0];
  const [revision, setRevision] = useState(
      storedState?.changes[0]?.staged_in ?? skill.revision,
    ),
    [path, setPath] = useState("SKILL.md"),
    [loaded, setLoaded] = useState<Loaded | null>(null),
    // Issue #17/#31: drafts live per revision+path so file/revision switches
    // never silently drop unsent user text.
    [drafts, setDrafts] = useState<Record<string, string>>(
      storedState?.drafts ?? {},
    ),
    [bases, setBases] = useState<Record<string, string>>(
      storedState?.bases ?? {},
    ),
    [changes, setChanges] = useState<Change[]>(storedState?.changes ?? []),
    [rebase, setRebase] = useState(storedState?.rebase ?? false),
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
      next?: string | null;
    }>(`/api/skills/${skill.skill_id}/revisions`, { follow: true }),
    manifest = useResource<Manifest>(
      `/api/skills/${skill.skill_id}/manifest?revision=${revision}`,
    );
  const stateRef = useRef<DraftSnapshot>({
    drafts,
    bases,
    changes,
    rebase,
  });
  stateRef.current = { drafts, bases, changes, rebase };
  const closingRef = useRef(false);
  // Persist on every change so a transition cannot lose the latest text...
  useEffect(() => {
    writeDraftSnapshot(scopeKey, stateRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, bases, changes, rebase, scopeKey]);
  // ...and again on unmount for a state update that did not flush first.
  useEffect(() => {
    const scope = scopeKey;
    return () => {
      if (!closingRef.current) writeDraftSnapshot(scope, stateRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);
  useEffect(() => {
    setLoaded(null);
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [revision, path]);
  const draftKey = draftKeyOf(revision, path);
  const stagedContent = stagedContentFor({ changes }, revision, path);
  const draft = drafts[draftKey] ?? stagedContent ?? loaded?.content ?? "";
  const currentFileDirty = draftDirty(
    { drafts, bases, changes },
    revision,
    path,
  );
  const dirty = unpublishedWork({ drafts, bases, changes });
  const unstagedCount = unstagedDraftCount(
    { drafts, bases, changes },
    revision,
  );
  const activeRevision = revision === skill.revision;
  const staleRevision = !activeRevision && dirty;
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
    } catch (e) {
      if (token === generation.current) setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  async function moreFiles() {
    // Issue #20: bind the paged response to its request lifecycle. The
    // shared generation token bumps on any revision/path change, so a stale
    // page can never merge into a newer revision's file list; the cursor
    // check deduplicates concurrent clicks on the same page.
    const requestCursor = manifest.data?.next;
    if (requestCursor === null || requestCursor === undefined) return;
    const token = generation.current;
    try {
      const next = await api<Manifest>(
        `/api/skills/${skill.skill_id}/manifest?revision=${revision}&after=${requestCursor}`,
      );
      if (token !== generation.current) return;
      manifest.setData((current) =>
        current && current.next === requestCursor
          ? {
              ...current,
              files: [...current.files, ...next.files],
              next: next.next,
            }
          : current,
      );
    } catch (e) {
      setError(errorCode(e));
    }
  }
  function stage(content: string | null) {
    const hash = manifest.data?.files.find((f) => f.path === path)?.hash;
    if (!hash) {
      setError("client_inventory_required");
      return;
    }
    setChanges([
      ...changes.filter(
        (c) => !(c.path === path && (c.staged_in ?? revision) === revision),
      ),
      { path, original_hash: hash, content, staged_in: revision },
    ]);
  }
  function finishClose(discard: boolean) {
    closingRef.current = true;
    if (discard) clearDraftSnapshot(scopeKey);
    close();
  }
  async function publish() {
    // Issue #31: publish sends a captured snapshot of the candidates. The
    // button is blocked while a newer editor draft exists for a staged file,
    // so the last user text can never silently diverge from the request.
    if (unstagedCount > 0 || changes.length === 0) return;
    setBusy(true);
    setError("");
    const snapshot = changes.map(({ staged_in: _stagedIn, ...rest }) => rest);
    const publishedKeys = new Set(
      changes.map((change) =>
        draftKeyOf(change.staged_in ?? revision, change.path),
      ),
    );
    try {
      await api(`/api/skills/${skill.skill_id}/edit`, {
        method: "POST",
        body: JSON.stringify({
          base_revision: skill.revision,
          changes: snapshot,
          rebase,
        }),
      });
    } catch (e) {
      setError(errorCode(e));
      setBusy(false);
      return;
    }
    setChanges((current) =>
      current.filter(
        (change) => !snapshot.some((sent) => sent.path === change.path),
      ),
    );
    setDrafts((current) => omitKeys(current, publishedKeys));
    setBases((current) => omitKeys(current, publishedKeys));
    setRebase(false);
    closingRef.current = true;
    clearDraftSnapshot(scopeKey);
    try {
      await refresh();
    } finally {
      close();
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
      // Issue #17: metadata operations must not destroy the content
      // candidate; the detail stays open with its drafts.
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  async function rollback() {
    // Issue #31: rolling back abandons every unpublished candidate and
    // draft, so it asks before a real loss.
    if (dirty && !window.confirm(t("pkgdetail.confirmRollback"))) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/skills/${skill.skill_id}/rollback`, {
        method: "POST",
        body: JSON.stringify({
          base_revision: skill.revision,
          target_revision: revision,
        }),
      });
    } catch (e) {
      setError(errorCode(e));
      setBusy(false);
      return;
    }
    closingRef.current = true;
    clearDraftSnapshot(scopeKey);
    await refresh();
    close();
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
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  const editable =
    !skill.pinned &&
    !skill.protected &&
    skill.managed &&
    (activeRevision || dirty);
  const canPublish = changes.length > 0 && unstagedCount === 0;
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{skill.name}</h2>
        <button
          disabled={busy}
          onClick={() => {
            // Issue #17/#31: closing is the only flow that discards drafts
            // and candidates, so it warns when unsent work would be lost.
            if (dirty && !window.confirm(t("pkgdetail.confirmClose"))) return;
            finishClose(true);
          }}
        >
          {t("common.close")}
        </button>
      </div>
      <ErrorNotice message={error || revisions.error || manifest.error} />
      <div className="toolbar">
        <label>
          {t("pkgdetail.versionLabel")}
          <select
            value={revision}
            disabled={busy || changes.length > 0}
            onChange={(e) => setRevision(e.target.value)}
          >
            {revisions.data?.items.map((row) => (
              <option key={row.revision} value={row.revision}>
                {row.revision.slice(0, 10)} · {date(row.created_at, lang)} ·{" "}
                {row.validation_passed
                  ? t("pkgdetail.verified")
                  : t("pkgdetail.unverified")}
              </option>
            ))}
          </select>
        </label>
        <a
          className="button"
          href={`/api/skills/${skill.skill_id}/export?revision=${revision}`}
        >
          <Download size={16} />
          {t("pkgdetail.downloadZip")}
        </a>
        <button
          disabled={busy || activeRevision}
          onClick={() => void rollback()}
        >
          {t("pkgdetail.rollbackTo")}
        </button>
      </div>
      {staleRevision && (
        <p data-testid="stale-revision-note">
          <small>{t("pkgdetail.revisionRefreshNote")}</small>
        </p>
      )}
      <div className="file-list" aria-label={t("pkgdetail.filesAria")}>
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
          <button disabled={busy} onClick={() => void moreFiles()}>
            {t("pkgdetail.moreFiles")}
          </button>
        )}
      </div>
      <div className="toolbar">
        <strong className="mono">{path}</strong>
        <button disabled={busy} onClick={() => void load()}>
          {t("pkgdetail.readFile")}
        </button>
        {loaded?.next_cursor && (
          <button
            disabled={busy}
            onClick={() => void load(loaded.next_cursor!)}
          >
            {t("pkgdetail.loadMore")}
          </button>
        )}
      </div>
      {loaded && (
        <>
          <pre className="code-view">{loaded.content}</pre>
          <small>
            {loaded.encoding === "base64"
              ? t("pkgdetail.binaryLabel")
              : t("pkgdetail.textLabel")}{" "}
            {t("pkgdetail.totalBytes", { total: loaded.total_bytes })}{" "}
            {loaded.next_cursor
              ? t("pkgdetail.partialContent")
              : t("pkgdetail.fullContent")}
          </small>
          {editable && loaded.encoding === "utf8" && !loaded.next_cursor && (
            <>
              <label>
                {t("pkgdetail.editFile")}
                <textarea
                  className="code-editor"
                  rows={12}
                  value={draft}
                  disabled={busy}
                  title={currentFileDirty ? t("pkgdetail.dirty") : undefined}
                  onChange={(e) => {
                    const value = e.target.value;
                    const key = draftKey;
                    if (drafts[key] === undefined)
                      setBases((current) => ({ ...current, [key]: draft }));
                    setDrafts((current) => ({ ...current, [key]: value }));
                  }}
                />
              </label>
              <div className="toolbar">
                <button
                  disabled={busy || changes.length >= 16}
                  onClick={() => stage(draft)}
                >
                  {t("pkgdetail.stageChange")}
                </button>
                <button
                  disabled={busy || path === "SKILL.md"}
                  onClick={() => stage(null)}
                >
                  <Trash2 size={16} />
                  {t("pkgdetail.stageDelete")}
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
              {t("pkgdetail.addFileSummary")}
            </summary>
            <p>{t("pkgdetail.addFileNote")}</p>
            <label>
              {t("pkgdetail.newPathLabel")}
              <input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder={t("pkgdetail.newPathPh")}
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
                  setError("client_path_invalid");
                  return;
                }
                setChanges([
                  ...changes,
                  {
                    path: newPath,
                    original_hash: null,
                    content: "",
                    staged_in: revision,
                  },
                ]);
                setNewPath("");
              }}
            >
              {t("pkgdetail.addDraft")}
            </button>
          </details>
          {changes.length > 0 && (
            <div className="candidate-panel">
              <h3>
                {t("pkgdetail.candidateTitle", { count: changes.length })}
              </h3>
              {changes.map((c) => (
                <details key={c.path} open>
                  <summary>
                    {c.path} ·{" "}
                    {c.content === null
                      ? t("pkgdetail.willDelete")
                      : c.original_hash
                        ? t("pkgdetail.willChange")
                        : t("pkgdetail.willAdd")}
                  </summary>
                  {c.content !== null && (
                    <label>
                      {t("pkgdetail.candidateContent")}
                      <textarea
                        className="code-editor"
                        rows={6}
                        value={c.content}
                        disabled={busy}
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
                    {t("pkgdetail.removeChange")}
                  </button>
                </details>
              ))}
              <p>{t("pkgdetail.publishNote")}</p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={rebase}
                  disabled={busy}
                  onChange={(event) => setRebase(event.target.checked)}
                />{" "}
                {t("pkgdetail.rebaseLabel")}
              </label>
              {unstagedCount > 0 && (
                <p data-testid="unstaged-draft-note">
                  <small>{t("pkgdetail.stageBeforePublish")}</small>
                </p>
              )}
              <button
                className="primary"
                disabled={busy || !canPublish}
                onClick={() => void publish()}
              >
                <Save size={16} />
                {busy ? t("pkgdetail.verifying") : t("pkgdetail.publishRun")}
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
        <summary>{t("pkgdetail.validationProof")}</summary>
        <pre>{JSON.stringify(manifest.data?.validation ?? null, null, 2)}</pre>
      </details>
      {manifest.data?.execution && (
        <details>
          <summary>
            <Play size={16} />
            {t("pkgdetail.runScript")}
          </summary>
          <label>
            {t("pkgdetail.entryLabel")}
            <select value={entry} onChange={(e) => setEntry(e.target.value)}>
              <option value="">{t("pkgdetail.entrySelect")}</option>
              {Object.keys(manifest.data.execution.entrypoints).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          {entry && (
            <>
              <details>
                <summary>{t("pkgdetail.schemaSummary")}</summary>
                <pre>
                  {JSON.stringify(
                    manifest.data.execution.entrypoints[entry],
                    null,
                    2,
                  )}
                </pre>
              </details>
              <label>
                {t("pkgdetail.jsonInput")}
                <textarea
                  className="code-editor"
                  rows={5}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <button disabled={busy} onClick={() => void run()}>
                {t("pkgdetail.runSandbox")}
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
          {skill.pinned ? t("pkgdetail.unpin") : t("pkgdetail.pin")}
        </button>
        <button
          disabled={busy}
          onClick={() => void configure("protected", !skill.protected)}
        >
          {skill.protected ? t("pkgdetail.unprotect") : t("pkgdetail.protect")}
        </button>
        <button
          disabled={busy}
          onClick={() => void configure("managed", !skill.managed)}
        >
          {skill.managed ? t("pkgdetail.managedOff") : t("pkgdetail.managedOn")}
        </button>
        <a className="button" href="#maintenance">
          {t("pkgdetail.maintenanceLink")}
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
  const { t } = useLang();
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
      if (generation.current === token) setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>{t("pkgdetail.compareTitle")}</summary>
      <label>
        {t("pkgdetail.compareLabel")}
        <select
          value={other}
          disabled={busy}
          onChange={(e) => setOther(e.target.value)}
        >
          <option value="">{t("pkgdetail.compareSelect")}</option>
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
        {t("pkgdetail.compareBtn")}
      </button>
      <ErrorNotice message={error} />
      {comparison && (
        <>
          <p>
            {comparison.left?.next_cursor || comparison.right?.next_cursor
              ? t("pkgdetail.comparePartial")
              : comparison.left?.content === comparison.right?.content
                ? t("pkgdetail.compareSame")
                : t("pkgdetail.compareDifferent")}
          </p>
          <div className="comparison-grid">
            <div>
              <h3>{other.slice(0, 12)}</h3>
              <pre className="code-view">
                {comparison.left?.content ?? t("pkgdetail.compareMissing")}
              </pre>
            </div>
            <div>
              <h3>{revision.slice(0, 12)}</h3>
              <pre className="code-view">
                {comparison.right?.content ?? t("pkgdetail.compareMissing")}
              </pre>
            </div>
          </div>
        </>
      )}
    </details>
  );
}
