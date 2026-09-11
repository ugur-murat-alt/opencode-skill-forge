import { useEffect, useRef, useState } from "react";
import { errorCode } from "../api";
import { useLang } from "../i18n/lang";
import { ErrorNotice, Status, date } from "../ui";
import {
  TASK_STATUS_OPTIONS,
  memoryCheckpoint,
  memoryTasks,
  memoryUpdate,
  type MemoryTaskPage,
  type MemoryTaskRow,
} from "./api";

/**
 * Issue #37 (M04) phase B: derived task views. Rows are canonical task notes;
 * status changes go to the note revision through the synchronous update
 * endpoint. A session end never marks a task done: only an explicit choice
 * writes `done`.
 */
export function TasksView({
  spaceId,
  onSelectNote,
  onChanged,
}: {
  spaceId: string;
  onSelectNote: (noteId: string) => void;
  onChanged: () => void;
}) {
  const { t, lang } = useLang();
  const [mode, setMode] = useState<"all" | "week">("all");
  const [page, setPage] = useState<MemoryTaskPage | null>(null);
  const [items, setItems] = useState<MemoryTaskRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyRow, setBusyRow] = useState("");
  const [target, setTarget] = useState<MemoryTaskRow | null>(null);
  const [goal, setGoal] = useState("");
  const [progress, setProgress] = useState("");
  const [blocker, setBlocker] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);

  async function load(cursor?: string) {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await memoryTasks(spaceId, {
        after: cursor,
        limit: 100,
        weekOnly: mode === "week",
      });
      if (request !== generation.current) return;
      const rows = cursor ? [...items, ...result.items] : result.items;
      rows.sort(
        (a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id),
      );
      setItems(rows);
      setPage(result);
      setNext(result.next);
    } catch (caught) {
      if (request === generation.current) setError(errorCode(caught));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, mode]);

  async function updateStatus(row: MemoryTaskRow, value: string) {
    if (!row.current_revision || busyRow) return;
    setBusyRow(row.id);
    setError("");
    setNotice("");
    try {
      await memoryUpdate({
        spaceId,
        noteId: row.id,
        expectedRevision: row.current_revision,
        patch: { task_status: value },
      });
      setNotice(t("memory.notices.taskUpdated"));
      await load();
      onChanged();
    } catch (caught) {
      setError(
        errorCode(caught) === "memory_revision_conflict"
          ? t("memory.tasks.updateFailed")
          : errorCode(caught),
      );
      await load();
    } finally {
      setBusyRow("");
    }
  }

  async function saveCheckpoint() {
    if (!goal.trim() || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await memoryCheckpoint({
        spaceId,
        goal: goal.trim(),
        progress: progress.trim() || undefined,
        blocker: blocker.trim() || undefined,
        nextStep: nextStep.trim() || undefined,
        status: status || undefined,
        noteId: target?.id,
        expectedRevision: target?.current_revision ?? undefined,
      });
      setNotice(t("memory.notices.checkpointSaved"));
      setGoal("");
      setProgress("");
      setBlocker("");
      setNextStep("");
      setStatus("");
      setTarget(null);
      await load();
      onChanged();
    } catch (caught) {
      setError(errorCode(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="memory-tasks-panel"
      aria-label={t("memory.tasks.title")}
    >
      <h2>{t("memory.tasks.title")}</h2>
      <p className="subtitle">{t("memory.tasks.subtitle")}</p>
      <div className="toolbar">
        <button
          data-testid="memory-tasks-all"
          className={mode === "all" ? "primary" : ""}
          onClick={() => setMode("all")}
        >
          {t("memory.tasks.all")}
        </button>
        <button
          data-testid="memory-tasks-week"
          className={mode === "week" ? "primary" : ""}
          onClick={() => setMode("week")}
        >
          {t("memory.tasks.week")}
        </button>
        {page && (
          <small data-testid="memory-tasks-week-window">
            {mode === "week" ? `${t("memory.tasks.weekHint")} ` : ""}
            {date(page.week.week_start, lang)} –{" "}
            {date(page.week.week_end, lang)} · {t("memory.tasks.timezone")}:{" "}
            {page.week.timezone}
          </small>
        )}
      </div>
      <p className="muted">
        <small>{t("memory.tasks.sessionHint")}</small>
      </p>
      <ErrorNotice message={error} />
      {notice && (
        <p className="memory-notice" role="status">
          {notice}
        </p>
      )}
      {items.length === 0 && !loading ? (
        <p className="muted" data-testid="memory-tasks-empty">
          {t("memory.tasks.empty")}
        </p>
      ) : (
        <ul className="memory-task-list" data-testid="memory-task-list">
          {items.map((row) => (
            <li key={row.id}>
              <div className="memory-task-row">
                <button
                  className="link-button"
                  data-testid="memory-task-open"
                  onClick={() => onSelectNote(row.id)}
                >
                  <strong>{row.title}</strong>
                </button>
                <Status value={row.task_status} />
                {row.pinned && (
                  <span className="memory-chip">{t("memory.list.pinned")}</span>
                )}
                <small>
                  {t("memory.tasks.updated")}: {date(row.updated_at, lang)}
                </small>
                <select
                  data-testid="memory-task-status"
                  aria-label={t("memory.tasks.status")}
                  value={row.task_status}
                  disabled={busyRow === row.id}
                  onChange={(event) =>
                    void updateStatus(row, event.target.value)
                  }
                >
                  {TASK_STATUS_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <button
                  className="link-button"
                  data-testid="memory-task-checkpoint"
                  onClick={() => {
                    setTarget(row);
                    setGoal(row.title);
                    setStatus("");
                  }}
                >
                  {t("memory.tasks.attach")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button
          data-testid="memory-tasks-more"
          disabled={loading}
          onClick={() => void load(next)}
        >
          {t("memory.tasks.more")}
        </button>
      )}
      <h3>
        {t("memory.tasks.checkpointTitle")}
        {target ? ` · ${target.title}` : ` · ${t("memory.tasks.newTask")}`}
      </h3>
      <form
        className="memory-checkpoint"
        onSubmit={(event) => {
          event.preventDefault();
          void saveCheckpoint();
        }}
      >
        <label>
          {t("memory.tasks.goal")}
          <input
            data-testid="memory-checkpoint-goal"
            required
            value={goal}
            placeholder={t("memory.tasks.goalPh")}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <label>
          {t("memory.tasks.progress")}
          <textarea
            rows={2}
            value={progress}
            onChange={(event) => setProgress(event.target.value)}
          />
        </label>
        <label>
          {t("memory.tasks.blocker")}
          <textarea
            rows={2}
            data-testid="memory-checkpoint-blocker"
            value={blocker}
            onChange={(event) => setBlocker(event.target.value)}
          />
        </label>
        <label>
          {t("memory.tasks.nextStep")}
          <textarea
            rows={2}
            value={nextStep}
            onChange={(event) => setNextStep(event.target.value)}
          />
        </label>
        <label>
          {t("memory.tasks.statusLabel")}
          <select
            data-testid="memory-checkpoint-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">{t("memory.tasks.autoStatus")}</option>
            {TASK_STATUS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <div className="toolbar">
          <button
            className="primary"
            data-testid="memory-checkpoint-save"
            disabled={saving || !goal.trim()}
          >
            {saving ? t("memory.tasks.saving") : t("memory.tasks.save")}
          </button>
          {target && (
            <button type="button" onClick={() => setTarget(null)}>
              {t("common.cancel")}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
