import { useEffect, useRef, useState } from "react";
import { Archive, FileText, Pin, Plus, RotateCcw } from "lucide-react";
import { errorCode } from "./api";
import { useLang } from "./i18n/lang";
import { ErrorNotice, Empty, Refresh, Status, date, useResource } from "./ui";
import { Markdown } from "./memory/Markdown";
import { SourcePanel } from "./memory/SourcePanel";
import { GraphView } from "./memory/GraphView";
import { SearchPanel } from "./memory/SearchPanel";
import { ContextPanel } from "./memory/ContextPanel";
import { TasksView } from "./memory/TasksView";
import { ReviewPanel } from "./memory/ReviewPanel";
import { HealthPanel } from "./memory/HealthPanel";
import {
  ensureMemorySpace,
  isRevisionConflict,
  memoryArchive,
  memoryIngest,
  memoryNote,
  memoryReceipt,
  memoryRestore,
  memoryRevision,
  memoryUpdate,
  type MemoryCandidate,
  type MemoryNoteDetail,
  type MemoryNoteList,
  type MemoryReceipt,
  type MemoryRevision,
  type MemoryRevisionPage,
  type MemorySourceRow,
  type MemorySpace,
} from "./memory/api";
import {
  applyNoteEdits,
  createNoteDocument,
  splitMemoryDocument,
} from "./memory/document";
import {
  draftDirty,
  emptyMemorySnapshot,
  findDraftForNote,
  memoryDraftIdentity,
  memoryScopeKey,
  pendingForNote,
  readMemorySnapshot,
  readRecentNotes,
  rememberRecentNote,
  unpublishedWork,
  writeMemorySnapshot,
  type MemoryDraft,
  type MemoryDraftServerState,
  type MemoryDraftSnapshot,
  type MemoryPendingSave,
} from "./memory/drafts";

const NOTE_KINDS = [
  "note",
  "decision",
  "fact",
  "procedure",
  "context",
  "research",
  "preference",
  "task",
  "session",
] as const;

function serverBaseline(
  detail: MemoryNoteDetail | null,
): MemoryDraftServerState {
  const content = detail?.content ?? "";
  const split = splitMemoryDocument(content);
  return {
    title: detail?.revision?.title ?? detail?.note.title ?? "",
    summary: detail?.revision?.summary ?? detail?.note.summary ?? "",
    body: content ? split.body : "",
    kind: detail?.revision?.kind ?? "note",
    revision:
      detail?.revision?.revision ?? detail?.note.current_revision ?? null,
  };
}

function emptyBaseline(): MemoryDraftServerState {
  return { title: "", summary: "", body: "", kind: "note", revision: null };
}

function PendingChip({ pending }: { pending: MemoryPendingSave }) {
  const { t, err } = useLang();
  if (pending.status === "queued")
    return (
      <span className="memory-chip" data-testid="memory-pending-queued">
        {t("memory.status.queued")}
      </span>
    );
  if (pending.status === "rejected")
    return (
      <span
        className="memory-chip memory-chip-error"
        data-testid="memory-pending-rejected"
      >
        {t("memory.status.rejected")}
        {pending.errorCode ? `: ${err(pending.errorCode)}` : ""}
      </span>
    );
  return (
    <>
      <span className="memory-chip" data-testid="memory-pending-committed">
        {t("memory.status.committed")}
      </span>
      {!pending.indexed && (
        <span className="memory-chip">{t("memory.status.indexing")}</span>
      )}
    </>
  );
}

function MemoryWorkspace({
  tenant,
  space,
  canWrite,
}: {
  tenant: string;
  space: MemorySpace;
  canWrite: boolean;
}) {
  const { t, lang } = useLang();
  const spaceId = space.id;
  const scopeKey = memoryScopeKey(tenant, spaceId);
  const [snapshot, setSnapshot] = useState<MemoryDraftSnapshot>(
    () => readMemorySnapshot(scopeKey) ?? emptyMemorySnapshot(),
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    writeMemorySnapshot(scopeKey, snapshot);
  }, [scopeKey, snapshot]);

  const [noteId, setNoteId] = useState("");
  const [newNoteId, setNewNoteId] = useState("");
  const [view, setView] = useState<
    "notes" | "search" | "context" | "tasks" | "review" | "health"
  >("notes");
  const [detailTab, setDetailTab] = useState<"editor" | "links">("editor");
  const [fields, setFields] = useState({
    title: "",
    summary: "",
    body: "",
    kind: "note" as string,
  });
  const [preview, setPreview] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<{
    revision: number;
    content: string | null;
  } | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const pollBudget = useRef(0);
  const [recent, setRecent] = useState<string[]>(() =>
    readRecentNotes(tenant, spaceId),
  );

  const activeId = newNoteId || noteId;
  const list = useResource<MemoryNoteList>(
    `/api/memory/notes?space_id=${encodeURIComponent(spaceId)}`,
  );
  const detail = useResource<MemoryNoteDetail>(
    noteId
      ? `/api/memory/notes/${encodeURIComponent(noteId)}?space_id=${encodeURIComponent(spaceId)}`
      : null,
  );
  const revisions = useResource<MemoryRevisionPage>(
    noteId
      ? `/api/memory/notes/${encodeURIComponent(noteId)}/revisions?space_id=${encodeURIComponent(spaceId)}`
      : null,
  );
  const conflicts = useResource<{
    items: MemoryCandidate[];
    next: string | null;
  }>(
    noteId
      ? `/api/memory/conflicts?space_id=${encodeURIComponent(spaceId)}&note_id=${encodeURIComponent(noteId)}`
      : null,
  );
  const sources = useResource<{ items: MemorySourceRow[] }>(
    `/api/memory/sources?space_id=${encodeURIComponent(spaceId)}`,
  );
  // A detail response is authoritative only for the note it belongs to: a
  // still-rendered previous note must never feed the editor or the save path.
  const activeDetail =
    detail.data && detail.data.note.id === activeId ? detail.data : null;

  const activeDraft = activeId ? findDraftForNote(snapshot, activeId) : null;
  const activePending = activeId ? pendingForNote(snapshot, activeId) : [];
  const queuedPending = activePending.find(
    (pending) => pending.status === "queued",
  );
  const rejectedConflict =
    activePending.find(
      (pending) =>
        pending.status === "rejected" && isRevisionConflict(pending.errorCode),
    ) ?? null;
  const publishedPending = activePending.filter(
    (pending) => pending.status === "committed",
  );
  const dirty = Boolean(activeDraft && draftDirty(activeDraft));
  const baseline = newNoteId ? emptyBaseline() : serverBaseline(activeDetail);
  const editorRef = useRef<{ id: string; revision: number | null } | null>(
    null,
  );

  // Editor initialization: a draft always wins over the server copy; a newer
  // server revision only refreshes the editor when no draft exists.
  useEffect(() => {
    const id = activeId;
    if (!id) {
      editorRef.current = null;
      return;
    }
    if (!newNoteId && !activeDetail) return;
    const server = newNoteId ? emptyBaseline() : serverBaseline(activeDetail);
    const draft = findDraftForNote(snapshotRef.current, id);
    const prior = editorRef.current;
    if (prior && prior.id === id) {
      if (draft) return;
      if (prior.revision === server.revision) return;
    }
    editorRef.current = { id, revision: server.revision };
    if (draft)
      setFields({
        title: draft.title,
        summary: draft.summary,
        body: draft.body,
        kind: draft.kind,
      });
    else
      setFields({
        title: server.title,
        summary: server.summary,
        body: server.body,
        kind: server.kind,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeDetail, newNoteId]);

  function updateFields(patch: Partial<typeof fields>) {
    const next = { ...fields, ...patch };
    setFields(next);
    const id = activeId;
    if (!id) return;
    const server = newNoteId ? emptyBaseline() : serverBaseline(activeDetail);
    const existing = findDraftForNote(snapshotRef.current, id);
    const baseRevision = existing?.baseRevision ?? server.revision;
    const draft: MemoryDraft = {
      noteId: id,
      title: next.title,
      summary: next.summary,
      body: next.body,
      kind: next.kind,
      baseRevision,
      server,
      updatedAt: Date.now(),
    };
    const draftKey = memoryDraftIdentity(tenant, spaceId, id, baseRevision);
    const drafts: Record<string, MemoryDraft> = {};
    for (const [key, value] of Object.entries(snapshotRef.current.drafts))
      if (value.noteId !== id) drafts[key] = value;
    drafts[draftKey] = draft;
    setSnapshot((prev) => ({ ...prev, drafts }));
  }

  function updatePending(eventKey: string, receipt: MemoryReceipt) {
    const entry = snapshotRef.current.pending[eventKey];
    if (!entry) return;
    const failed =
      receipt.state === "rejected" || receipt.run_state === "failed";
    const status: MemoryPendingSave["status"] =
      receipt.state === "committed"
        ? "committed"
        : failed
          ? "rejected"
          : "queued";
    setSnapshot((prev) => ({
      ...prev,
      pending: {
        ...prev.pending,
        [eventKey]: {
          ...entry,
          status,
          indexed: receipt.indexed,
          errorCode: receipt.error_code ?? receipt.run_error_code,
          committedRevision: receipt.committed_revision,
          updatedAt: Date.now(),
        },
      },
    }));
    if (receipt.state === "committed") {
      const draft = findDraftForNote(snapshotRef.current, entry.noteId);
      if (
        draft &&
        draft.title === entry.submitted.title &&
        draft.summary === entry.submitted.summary &&
        draft.body === entry.submitted.body
      )
        clearNoteDraft(entry.noteId);
      if (newNoteId && newNoteId === entry.noteId) {
        setNewNoteId("");
        setNoteId(entry.noteId);
      }
      void list.refresh();
      if (noteId === entry.noteId) void detail.refresh();
    } else if (failed) {
      if (noteId === entry.noteId) void detail.refresh();
    }
  }

  // Receipt polling: bounded, resumes while queued entries remain. A missing
  // receipt means the worker has not recorded the event yet.
  useEffect(() => {
    const queued = Object.values(snapshot.pending).filter(
      (pending) => pending.status === "queued",
    );
    if (queued.length === 0) {
      pollBudget.current = 0;
      return;
    }
    if (pollBudget.current > 80) return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let waiting = false;
        for (const pending of queued) {
          try {
            const receipt = await memoryReceipt(spaceId, pending.eventKey);
            if (stopped) return;
            if (!receipt) {
              waiting = true;
              continue;
            }
            updatePending(pending.eventKey, receipt);
          } catch {
            waiting = true;
          }
        }
        if (!stopped && waiting) {
          pollBudget.current += 1;
          setPollTick((value) => value + 1);
        }
      })();
    }, 700);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.pending, spaceId, pollTick]);

  function clearNoteDraft(id: string) {
    setSnapshot((prev) => {
      const drafts: Record<string, MemoryDraft> = {};
      for (const [key, value] of Object.entries(prev.drafts))
        if (value.noteId !== id) drafts[key] = value;
      return { ...prev, drafts };
    });
  }

  function clearPendingForNote(id: string, statuses: string[]) {
    setSnapshot((prev) => {
      const pending: Record<string, MemoryPendingSave> = {};
      for (const [key, value] of Object.entries(prev.pending))
        if (!(value.noteId === id && statuses.includes(value.status)))
          pending[key] = value;
      return { ...prev, pending };
    });
  }

  function selectNote(id: string) {
    setNoteId(id);
    setNewNoteId("");
    setViewing(null);
    setError("");
    setNotice("");
    setView("notes");
    setDetailTab("editor");
    rememberRecentNote(tenant, spaceId, id);
    setRecent(readRecentNotes(tenant, spaceId));
  }

  function refreshNotes() {
    void list.refresh();
    void detail.refresh();
    void revisions.refresh();
  }

  async function togglePin() {
    if (!noteId || !activeDetail?.revision || busy) return;
    setBusy(true);
    setError("");
    try {
      await memoryUpdate({
        spaceId,
        noteId,
        expectedRevision: activeDetail.revision.revision,
        patch: { pinned: !activeDetail.note.pinned },
      });
      refreshNotes();
    } catch (caught) {
      setError(errorCode(caught));
      if (errorCode(caught) === "memory_revision_conflict") refreshNotes();
    } finally {
      setBusy(false);
    }
  }

  function startNewNote() {
    setNewNoteId(crypto.randomUUID());
    setNoteId("");
    setViewing(null);
    setError("");
    setNotice("");
    setView("notes");
    setDetailTab("editor");
    editorRef.current = null;
    setFields({ title: "", summary: "", body: "", kind: "note" });
  }

  async function submitDocument(input: {
    noteId: string;
    baseRevision: number | null;
    title: string;
    summary: string;
    body: string;
    document: string;
  }) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const eventKey = `ui-${crypto.randomUUID()}`;
      const result = await memoryIngest({
        spaceId,
        eventKey,
        sourceKind: "ui",
        content: input.document,
        noteId: input.noteId,
        baseRevision: input.baseRevision,
      });
      const pending: MemoryPendingSave = {
        eventKey,
        runId: result.run_id,
        noteId: input.noteId,
        baseRevision: input.baseRevision,
        submitted: {
          title: input.title,
          summary: input.summary,
          body: input.body,
          document: input.document,
        },
        status: "queued",
        indexed: false,
        errorCode: null,
        committedRevision: null,
        updatedAt: Date.now(),
      };
      pollBudget.current = 0;
      setSnapshot((prev) => ({
        ...prev,
        pending: { ...prev.pending, [eventKey]: pending },
      }));
      setNotice(t("memory.notices.queued"));
    } catch (caught) {
      setError(errorCode(caught));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const id = activeId;
    if (!id || saving || queuedPending) return;
    const title = fields.title.trim() || t("memory.editor.untitled");
    let document: string;
    if (newNoteId) {
      document = createNoteDocument(
        {
          noteId: newNoteId,
          spaceId,
          kind: fields.kind,
          title,
          summary: fields.summary,
        },
        fields.body,
      );
    } else {
      const content = activeDetail?.content ?? null;
      if (!content) {
        setError("memory_revision_file_missing");
        return;
      }
      document = applyNoteEdits(content, {
        title,
        summary: fields.summary,
        body: fields.body,
        kind: fields.kind,
      }).document;
    }
    await submitDocument({
      noteId: id,
      baseRevision: newNoteId
        ? null
        : (activeDraft?.baseRevision ?? baseline.revision),
      title,
      summary: fields.summary,
      body: fields.body,
      document,
    });
  }

  async function rebaseMine() {
    const id = noteId;
    if (!id || !rejectedConflict) return;
    setError("");
    try {
      const fresh = await memoryNote(spaceId, id);
      if (!fresh.content) {
        setError("memory_revision_file_missing");
        return;
      }
      const title = fields.title.trim() || t("memory.editor.untitled");
      const { document } = applyNoteEdits(fresh.content, {
        title,
        summary: fields.summary,
        body: fields.body,
        kind: fields.kind,
      });
      const freshBaseline = serverBaseline(fresh);
      setSnapshot((prev) => {
        const drafts: Record<string, MemoryDraft> = {};
        for (const [key, value] of Object.entries(prev.drafts)) {
          if (value.noteId !== id) {
            drafts[key] = value;
            continue;
          }
          const moved: MemoryDraft = {
            ...value,
            baseRevision: freshBaseline.revision,
            server: freshBaseline,
            updatedAt: Date.now(),
          };
          drafts[
            memoryDraftIdentity(tenant, spaceId, id, freshBaseline.revision)
          ] = moved;
        }
        return { ...prev, drafts };
      });
      clearPendingForNote(id, ["rejected"]);
      await submitDocument({
        noteId: id,
        baseRevision: freshBaseline.revision,
        title,
        summary: fields.summary,
        body: fields.body,
        document,
      });
      setNotice(t("memory.notices.rebaseStarted"));
      void detail.refresh();
    } catch (caught) {
      setError(errorCode(caught));
    }
  }

  async function loadServerRevision() {
    const id = noteId;
    if (!id) return;
    setError("");
    try {
      const fresh = await memoryNote(spaceId, id);
      clearNoteDraft(id);
      clearPendingForNote(id, ["rejected"]);
      const freshBaseline = serverBaseline(fresh);
      editorRef.current = { id, revision: freshBaseline.revision };
      setFields({
        title: freshBaseline.title,
        summary: freshBaseline.summary,
        body: freshBaseline.body,
        kind: freshBaseline.kind,
      });
      setViewing(null);
      setNotice(t("memory.notices.loadedFromServer"));
      void detail.refresh();
    } catch (caught) {
      setError(errorCode(caught));
    }
  }

  function discardDraft() {
    const id = activeId;
    if (!id) return;
    clearNoteDraft(id);
    clearPendingForNote(id, ["rejected"]);
    if (newNoteId) setNewNoteId("");
    editorRef.current = null;
    setNotice(t("memory.notices.draftDiscarded"));
    if (noteId) void detail.refresh();
  }

  async function toggleArchive(restore: boolean) {
    if (!noteId) return;
    setBusy(true);
    setError("");
    try {
      if (restore) await memoryRestore(spaceId, noteId);
      else await memoryArchive(spaceId, noteId);
      await list.refresh();
      await detail.refresh();
      setNotice(
        restore ? t("memory.notices.restored") : t("memory.notices.archived"),
      );
    } catch (caught) {
      setError(errorCode(caught));
    } finally {
      setBusy(false);
    }
  }

  async function viewRevision(row: MemoryRevision) {
    if (!noteId) return;
    setError("");
    try {
      const detailRow = await memoryRevision(spaceId, noteId, row.revision);
      setViewing({ revision: row.revision, content: detailRow.content });
    } catch (caught) {
      setError(errorCode(caught));
    }
  }

  const items = list.data?.items ?? [];
  const recentItems = recent
    .map((id) => items.find((note) => note.id === id))
    .filter((note): note is NonNullable<typeof note> => Boolean(note))
    .slice(0, 5);
  const revisionRows = revisions.data?.items ?? [];
  const conflictRows = conflicts.data?.items ?? [];
  const published = publishedPending[publishedPending.length - 1] ?? null;
  const serverBody = activeDetail?.content
    ? splitMemoryDocument(activeDetail.content).body
    : "";
  const note = activeDetail?.note ?? null;
  const archived = Boolean(note?.deleted_at);
  const canSave =
    !saving &&
    !archived &&
    !queuedPending &&
    Boolean(activeId) &&
    (Boolean(newNoteId) || Boolean(activeDetail?.content));

  return (
    <>
      <div className="memory-heading">
        <h2>{space.name}</h2>
        <span className="memory-chip">
          {space.kind === "personal"
            ? t("memory.spaces.personal")
            : space.kind === "project"
              ? t("memory.spaces.project")
              : t("memory.spaces.organization")}
        </span>
        {unpublishedWork(snapshot) && (
          <span
            className="memory-chip memory-chip-dirty"
            data-testid="memory-unpublished"
          >
            {t("memory.status.unpublished")}
          </span>
        )}
        <Refresh run={() => void list.refresh()} loading={list.loading} />
      </div>
      <nav className="memory-tabs" aria-label={t("memory.title")}>
        {(
          [
            ["notes", "memory.tabs.notes"],
            ["search", "memory.tabs.search"],
            ["context", "memory.tabs.context"],
            ["tasks", "memory.tabs.tasks"],
            ["review", "memory.tabs.review"],
            ["health", "memory.tabs.health"],
          ] as const
        ).map(([id, key]) => (
          <button
            key={id}
            data-testid={`memory-tab-${id}`}
            aria-current={view === id ? "page" : undefined}
            className={view === id ? "primary" : ""}
            onClick={() => setView(id)}
          >
            {t(key)}
          </button>
        ))}
      </nav>
      <ErrorNotice
        message={
          error ||
          list.error ||
          detail.error ||
          revisions.error ||
          conflicts.error ||
          sources.error
        }
      />
      {notice && (
        <p className="memory-notice" role="status">
          {notice}
        </p>
      )}
      <div
        className={`memory-layout ${activeId ? "detail-open" : ""}`}
        data-testid="memory-layout"
      >
        <section
          className="panel memory-list"
          aria-label={t("memory.list.title")}
        >
          <div className="toolbar">
            <button
              className="primary"
              data-testid="memory-new"
              onClick={startNewNote}
            >
              <Plus size={16} /> {t("memory.actions.newNote")}
            </button>
            {list.loading && (
              <small className="loading" role="status">
                {t("memory.list.loading")}
              </small>
            )}
          </div>
          {recentItems.length > 0 && (
            <>
              <h3>{t("memory.list.recent")}</h3>
              <ul className="memory-recent" data-testid="memory-recent">
                {recentItems.map((row) => (
                  <li key={row.id}>
                    <button
                      className="link-button"
                      onClick={() => selectNote(row.id)}
                    >
                      {row.title}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>{t("memory.list.title")}</h3>
          {items.length === 0 && !list.loading ? (
            <Empty
              title={t("memory.list.emptyTitle")}
              detail={t("memory.list.emptyDetail")}
            />
          ) : (
            <ul className="memory-notes">
              {items.map((row) => (
                <li key={row.id}>
                  <button
                    className={`memory-note ${activeId === row.id ? "active" : ""}`}
                    data-testid="memory-note"
                    aria-current={activeId === row.id ? "true" : undefined}
                    onClick={() => selectNote(row.id)}
                  >
                    <span className="memory-note-title">{row.title}</span>
                    <span className="memory-note-meta">
                      {row.deleted_at !== null && <Status value="archived" />}
                      {row.pinned ? (
                        <span className="memory-chip">
                          {t("memory.list.pinned")}
                        </span>
                      ) : null}
                      {row.source_id && <small>{t("memory.list.bound")}</small>}
                      <small>{date(row.updated_at, lang)}</small>
                    </span>
                    {row.summary && (
                      <small className="description">{row.summary}</small>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.next !== null && (
            <button
              disabled={list.loadingMore}
              onClick={() => void list.loadMore()}
            >
              {t("memory.list.more")}
            </button>
          )}
        </section>
        {view === "notes" ? (
          <>
            <section
              className="panel memory-detail"
              aria-label={t("memory.title")}
            >
              {!activeId ? (
                <p className="muted">{t("memory.notices.selectNote")}</p>
              ) : (
                <>
                  <div className="memory-detail-head">
                    <button
                      className="link-button memory-back"
                      data-testid="memory-back"
                      onClick={() => {
                        setNoteId("");
                        setNewNoteId("");
                        setViewing(null);
                      }}
                    >
                      {t("memory.actions.back")}
                    </button>
                    <h2>
                      {newNoteId
                        ? t("memory.editor.newTitle")
                        : note?.title || t("memory.editor.untitled")}
                    </h2>
                    {queuedPending && <PendingChip pending={queuedPending} />}
                    {rejectedConflict && (
                      <PendingChip pending={rejectedConflict} />
                    )}
                    {!queuedPending && !rejectedConflict && published && (
                      <PendingChip pending={published} />
                    )}
                    {dirty && (
                      <span
                        className="memory-chip memory-chip-dirty"
                        data-testid="memory-dirty"
                      >
                        {t("memory.editor.dirty")}
                      </span>
                    )}
                    {!newNoteId && (
                      <button
                        className="icon-button"
                        data-testid="memory-pin-toggle"
                        aria-label={t("memory.actions.pin")}
                        title={t("memory.actions.pin")}
                        disabled={busy || !activeDetail?.revision}
                        onClick={() => void togglePin()}
                      >
                        <Pin size={15} />
                      </button>
                    )}
                  </div>
                  {!newNoteId && !viewing && (
                    <div className="toolbar memory-detail-tabs">
                      <button
                        data-testid="memory-detail-tab-editor"
                        className={detailTab === "editor" ? "primary" : ""}
                        aria-current={
                          detailTab === "editor" ? "page" : undefined
                        }
                        onClick={() => setDetailTab("editor")}
                      >
                        {t("memory.detailTabs.editor")}
                      </button>
                      <button
                        data-testid="memory-detail-tab-links"
                        className={detailTab === "links" ? "primary" : ""}
                        aria-current={
                          detailTab === "links" ? "page" : undefined
                        }
                        onClick={() => setDetailTab("links")}
                      >
                        {t("memory.detailTabs.links")}
                      </button>
                    </div>
                  )}
                  {rejectedConflict && (
                    <section
                      className="memory-conflict"
                      data-testid="memory-conflict"
                    >
                      <h3>{t("memory.conflict.title")}</h3>
                      <p>{t("memory.conflict.detail")}</p>
                      <div className="memory-conflict-grid">
                        <div>
                          <h4>{t("memory.conflict.mine")}</h4>
                          <pre>
                            {rejectedConflict.submitted.body.slice(0, 4000)}
                          </pre>
                        </div>
                        <div>
                          <h4>{t("memory.conflict.server")}</h4>
                          <pre>{serverBody.slice(0, 4000)}</pre>
                        </div>
                      </div>
                      <p>
                        <small>
                          {t("memory.conflict.myBase", {
                            revision: rejectedConflict.baseRevision ?? "—",
                          })}{" "}
                          ·{" "}
                          {t("memory.conflict.serverRevision", {
                            revision: activeDetail?.revision?.revision ?? "—",
                          })}
                        </small>
                      </p>
                      <button
                        className="primary"
                        data-testid="memory-rebase"
                        onClick={() => void rebaseMine()}
                      >
                        {t("memory.conflict.rebaseMine")}
                      </button>{" "}
                      <button
                        data-testid="memory-load-server"
                        onClick={() => void loadServerRevision()}
                      >
                        {t("memory.conflict.reloadServer")}
                      </button>
                    </section>
                  )}
                  {activeDraft &&
                    !rejectedConflict &&
                    activeDraft.baseRevision !== null &&
                    activeDetail?.revision &&
                    activeDraft.baseRevision !==
                      activeDetail.revision.revision && (
                      <p
                        className="memory-banner"
                        data-testid="memory-stale-base"
                      >
                        {t("memory.editor.staleBase")}
                      </p>
                    )}
                  {detailTab === "links" && !viewing && !newNoteId ? (
                    <GraphView
                      spaceId={spaceId}
                      detail={activeDetail}
                      notes={items}
                      canWrite={canWrite}
                      onSelectNote={selectNote}
                      onChanged={refreshNotes}
                    />
                  ) : viewing ? (
                    <section aria-label={t("memory.history.title")}>
                      <p
                        className="memory-banner"
                        data-testid="memory-viewing-revision"
                      >
                        {t("memory.history.viewing", {
                          revision: viewing.revision,
                        })}{" "}
                        · {t("memory.history.readOnly")}
                      </p>
                      <button
                        className="link-button"
                        onClick={() => setViewing(null)}
                      >
                        {t("memory.history.backToCurrent")}
                      </button>
                      {viewing.content === null ? (
                        <p className="muted">{t("memory.history.noContent")}</p>
                      ) : (
                        <Markdown
                          source={splitMemoryDocument(viewing.content).body}
                          testId="memory-history-preview"
                        />
                      )}
                    </section>
                  ) : (
                    <>
                      {!newNoteId && archived && (
                        <p
                          className="memory-banner"
                          data-testid="memory-archived"
                        >
                          {t("memory.source.state")}:{" "}
                          <Status value="archived" />.{" "}
                          {t("memory.actions.restore")}
                        </p>
                      )}
                      <div className="memory-fields">
                        <label>
                          {t("memory.editor.titleLabel")}
                          <input
                            data-testid="memory-title"
                            value={fields.title}
                            disabled={saving || archived}
                            onChange={(event) =>
                              updateFields({ title: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          {t("memory.editor.kindLabel")}
                          <select
                            data-testid="memory-kind"
                            value={fields.kind}
                            disabled={saving || archived}
                            onChange={(event) =>
                              updateFields({ kind: event.target.value })
                            }
                          >
                            {NOTE_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {kind}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="memory-summary-field">
                          {t("memory.editor.summaryLabel")}{" "}
                          <small>({t("memory.editor.summaryHint")})</small>
                          <textarea
                            rows={2}
                            data-testid="memory-summary"
                            value={fields.summary}
                            disabled={saving || archived}
                            onChange={(event) =>
                              updateFields({ summary: event.target.value })
                            }
                          />
                        </label>
                      </div>
                      <div className="memory-editor-head">
                        <strong>{t("memory.editor.bodyLabel")}</strong>
                        <button
                          className="link-button"
                          data-testid="memory-toggle-preview"
                          onClick={() => setPreview((value) => !value)}
                        >
                          {preview
                            ? t("memory.actions.edit")
                            : t("memory.actions.preview")}
                        </button>
                      </div>
                      {preview ? (
                        <Markdown
                          source={fields.body}
                          testId="memory-preview"
                        />
                      ) : (
                        <textarea
                          className="code-editor memory-editor"
                          rows={16}
                          data-testid="memory-body"
                          value={fields.body}
                          disabled={saving || archived}
                          aria-label={t("memory.editor.bodyLabel")}
                          onChange={(event) =>
                            updateFields({ body: event.target.value })
                          }
                        />
                      )}
                      <div className="toolbar">
                        <button
                          className="primary"
                          data-testid="memory-save"
                          disabled={!canSave}
                          onClick={() => void save()}
                        >
                          {saving
                            ? t("memory.actions.saving")
                            : t("memory.actions.save")}
                        </button>
                        {dirty && !queuedPending && (
                          <button
                            data-testid="memory-discard"
                            disabled={saving}
                            onClick={discardDraft}
                          >
                            {t("memory.actions.discard")}
                          </button>
                        )}
                        {!newNoteId && (
                          <button
                            data-testid="memory-archive-toggle"
                            disabled={busy || saving}
                            onClick={() => void toggleArchive(archived)}
                          >
                            {archived ? (
                              <>
                                <RotateCcw size={15} />{" "}
                                {t("memory.actions.restore")}
                              </>
                            ) : (
                              <>
                                <Archive size={15} />{" "}
                                {t("memory.actions.archive")}
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
            <SourcePanel
              detail={activeDetail}
              sources={sources.data?.items ?? []}
              conflicts={conflictRows}
              revisions={revisionRows}
              viewingRevision={viewing?.revision ?? null}
              onViewRevision={(row) => void viewRevision(row)}
              onBackToCurrent={() => setViewing(null)}
              onMoreRevisions={() => void revisions.loadMore()}
              hasMoreRevisions={revisions.next !== null}
            />
          </>
        ) : (
          <section
            className="panel memory-main-view"
            data-testid="memory-main-view"
            aria-label={t("memory.title")}
          >
            {view === "search" && (
              <SearchPanel spaceId={spaceId} onSelectNote={selectNote} />
            )}
            {view === "context" && (
              <ContextPanel spaceId={spaceId} onSelectNote={selectNote} />
            )}
            {view === "tasks" && (
              <TasksView
                spaceId={spaceId}
                onSelectNote={selectNote}
                onChanged={refreshNotes}
              />
            )}
            {view === "review" && (
              <ReviewPanel spaceId={spaceId} onSelectNote={selectNote} />
            )}
            {view === "health" && <HealthPanel spaceId={spaceId} />}
          </section>
        )}
      </div>
    </>
  );
}

export function Memory({
  tenant,
  project,
  canWrite,
}: {
  tenant: string;
  project: string;
  canWrite: boolean;
}) {
  const { t } = useLang();
  const spaces = useResource<{ items: MemorySpace[]; next: string | null }>(
    "/api/memory/spaces",
  );
  const [spaceId, setSpaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [orgName, setOrgName] = useState("");

  const items = spaces.data?.items ?? [];
  useEffect(() => {
    if (items.length === 0) {
      if (spaceId) setSpaceId("");
      return;
    }
    if (!spaceId || !items.some((space) => space.id === spaceId)) {
      const personal = items.find((space) => space.kind === "personal");
      setSpaceId(personal?.id ?? items[0]!.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaces.data]);

  const selected = items.find((space) => space.id === spaceId) ?? null;
  const personal = items.find((space) => space.kind === "personal");
  const projectSpace = items.find(
    (space) => space.kind === "project" && space.project_id === project,
  );

  async function createSpace(
    input:
      | { kind: "personal" }
      | { kind: "project"; projectId: string }
      | { kind: "organization"; name: string },
  ) {
    setBusy(true);
    setError("");
    try {
      const space = await ensureMemorySpace(
        input.kind === "project"
          ? { kind: "project", projectId: input.projectId }
          : input.kind === "organization"
            ? { kind: "organization", name: input.name }
            : { kind: "personal" },
      );
      await spaces.refresh();
      setSpaceId(space.id);
      setOrgName("");
    } catch (caught) {
      setError(errorCode(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="title-row">
        <div>
          <h1>{t("memory.title")}</h1>
          <p className="subtitle">{t("memory.subtitle")}</p>
        </div>
        <Refresh run={() => void spaces.refresh()} loading={spaces.loading} />
      </div>
      <ErrorNotice message={error || spaces.error} />
      <section className="panel memory-spaces">
        <div className="toolbar">
          <label>
            {t("memory.spaces.label")}
            <select
              data-testid="memory-space-select"
              value={spaceId}
              onChange={(event) => setSpaceId(event.target.value)}
            >
              {items.length === 0 && (
                <option value="">{t("memory.spaces.select")}</option>
              )}
              {items.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.kind === "personal"
                    ? t("memory.spaces.personal")
                    : space.kind === "project"
                      ? t("memory.spaces.project")
                      : t("memory.spaces.organization")}
                  : {space.name}
                </option>
              ))}
            </select>
          </label>
          {!personal && (
            <button
              disabled={busy}
              data-testid="memory-create-personal"
              onClick={() => void createSpace({ kind: "personal" })}
            >
              <Plus size={15} /> {t("memory.spaces.createPersonal")}
            </button>
          )}
          {project && !projectSpace && (
            <button
              disabled={busy}
              data-testid="memory-create-project"
              onClick={() =>
                void createSpace({
                  kind: "project",
                  projectId: project,
                })
              }
            >
              <FileText size={15} /> {t("memory.spaces.createProject")}
            </button>
          )}
          <label>
            {t("memory.spaces.orgNamePh")}
            <input
              value={orgName}
              placeholder={t("memory.spaces.orgNamePh")}
              onChange={(event) => setOrgName(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !orgName.trim()}
            data-testid="memory-create-org"
            onClick={() =>
              void createSpace({
                kind: "organization",
                name: orgName.trim(),
              })
            }
          >
            <Plus size={15} /> {t("memory.spaces.createOrg")}
          </button>
        </div>
        {items.length === 0 && (
          <Empty
            title={t("memory.spaces.emptyTitle")}
            detail={t("memory.spaces.emptyDetail")}
          />
        )}
        {items.length > 0 && spaces.next !== null && (
          <button
            disabled={busy || spaces.loadingMore}
            onClick={() => void spaces.loadMore()}
          >
            {t("memory.list.more")}
          </button>
        )}
      </section>
      {selected ? (
        <MemoryWorkspace
          key={`${tenant}:${selected.id}`}
          tenant={tenant}
          space={selected}
          canWrite={canWrite}
        />
      ) : (
        <section className="panel">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void createSpace({ kind: "personal" })}
          >
            <Plus size={16} /> {t("memory.spaces.createPersonal")}
          </button>
        </section>
      )}
    </>
  );
}
