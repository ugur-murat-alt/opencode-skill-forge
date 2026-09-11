import { useState, type ReactNode } from "react";
import { errorCode } from "../api";
import { useLang } from "../i18n/lang";
import { ErrorNotice } from "../ui";
import {
  memoryContext,
  type MemoryContextPackage,
  type MemoryContextCard,
} from "./api";

/**
 * Issue #37 (M04) phase B: the incremental context compiler view. Cards are
 * sourced and budgeted; truncation/continuation stay visible and delivery is
 * declared explicitly before a delta compile.
 */
export function ContextPanel({
  spaceId,
  onSelectNote,
}: {
  spaceId: string;
  onSelectNote: (noteId: string) => void;
}) {
  const { t } = useLang();
  const [goal, setGoal] = useState("");
  const [maxTokens, setMaxTokens] = useState(1024);
  const [known, setKnown] = useState<{ note_id: string; revision: number }[]>(
    [],
  );
  const [pkg, setPkg] = useState<MemoryContextPackage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function compile() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await memoryContext({
        spaceId,
        goal: goal.trim() || undefined,
        maxTokens,
        known: known.length > 0 ? known : undefined,
      });
      setPkg(result);
    } catch (caught) {
      setError(errorCode(caught));
    } finally {
      setBusy(false);
    }
  }

  function renderCard(card: MemoryContextCard) {
    return (
      <li key={`${card.space_id}\u0000${card.note_id}`}>
        <div className="memory-card-head">
          <strong>{card.title}</strong>
          <span className="memory-chip">{card.kind}</span>
          {card.pinned && (
            <span className="memory-chip">{t("memory.list.pinned")}</span>
          )}
          {card.task_status && (
            <span className="memory-chip">{card.task_status}</span>
          )}
          <span className="mono">
            {t("memory.context.tokenEstimate")} ~{card.token_estimate}
          </span>
        </div>
        <p className="memory-card-snippet">{card.snippet}</p>
        <small>
          {t("memory.search.matchReason")}: {card.match_reason}
        </small>
        <div className="toolbar">
          <small className="mono">
            {t("memory.note.revision", { revision: card.revision })}
          </small>
          <button
            className="link-button"
            data-testid="memory-context-open"
            onClick={() => onSelectNote(card.note_id)}
          >
            {t("memory.context.open")}
          </button>
        </div>
      </li>
    );
  }

  const sectionList = (
    label: string,
    ids: string[],
    testId: string,
  ): ReactNode => (
    <div className="memory-context-section">
      <h4>{label}</h4>
      {ids.length === 0 ? (
        <p className="muted">
          <small>—</small>
        </p>
      ) : (
        <ul data-testid={testId}>
          {ids.map((id) => (
            <li key={id}>
              <button className="link-button" onClick={() => onSelectNote(id)}>
                {id.slice(0, 12)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section
      className="memory-context-panel"
      aria-label={t("memory.context.title")}
    >
      <h2>{t("memory.context.title")}</h2>
      <p className="subtitle">{t("memory.context.subtitle")}</p>
      <form
        className="toolbar memory-context-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void compile();
        }}
      >
        <label className="search-field">
          {t("memory.context.goal")}
          <input
            data-testid="memory-context-goal"
            value={goal}
            placeholder={t("memory.context.goalPh")}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <label>
          {t("memory.context.maxTokens")}
          <select
            data-testid="memory-context-budget"
            value={maxTokens}
            onChange={(event) => setMaxTokens(Number(event.target.value))}
          >
            <option value={128}>128</option>
            <option value={512}>512</option>
            <option value={1024}>1024</option>
            <option value={2048}>2048</option>
            <option value={4096}>4096</option>
          </select>
        </label>
        <button
          className="primary"
          data-testid="memory-context-compile"
          disabled={busy}
        >
          {busy ? t("memory.context.compiling") : t("memory.context.compile")}
        </button>
        <button
          type="button"
          data-testid="memory-context-deliver"
          disabled={!pkg || (pkg.offered ?? []).length === 0}
          onClick={() => {
            setKnown((current) => {
              const merged = new Map(
                current.map((entry) => [
                  `${entry.note_id}\u0000${entry.revision}`,
                  entry,
                ]),
              );
              for (const offered of pkg?.offered ?? [])
                merged.set(`${offered.note_id}\u0000${offered.revision}`, {
                  note_id: offered.note_id,
                  revision: offered.revision,
                });
              return [...merged.values()];
            });
          }}
        >
          {t("memory.context.markDelivered")}
        </button>
      </form>
      <p className="muted">
        <small data-testid="memory-context-known">
          {t("memory.context.offered")}: {known.length}
        </small>
      </p>
      <ErrorNotice message={error} />
      {pkg && (
        <>
          <div className="memory-facts">
            <div>
              <dt>{t("memory.context.packageHash")}</dt>
              <dd className="mono">
                {pkg.envelope.package_hash.slice(0, 12)}…
              </dd>
            </div>
            <div>
              <dt>{t("memory.context.estimator")}</dt>
              <dd>{pkg.envelope.token_estimator}</dd>
            </div>
            <div>
              <dt>{t("memory.context.session")}</dt>
              <dd className="mono">{pkg.envelope.session_key ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("memory.context.generation")}</dt>
              <dd className="mono">{pkg.envelope.generation ?? "—"}</dd>
            </div>
          </div>
          {pkg.truncated && (
            <p className="memory-banner" data-testid="memory-context-truncated">
              {t("memory.context.truncated")}
            </p>
          )}
          <div className="memory-context-sections">
            {sectionList(
              t("memory.context.activeTasks"),
              pkg.sections?.active_tasks ?? [],
              "memory-context-active-tasks",
            )}
            {sectionList(
              t("memory.context.blockers"),
              pkg.sections?.blockers ?? [],
              "memory-context-blockers",
            )}
            {sectionList(
              t("memory.context.recentDecisions"),
              pkg.sections?.recent_decisions ?? [],
              "memory-context-decisions",
            )}
            {sectionList(
              t("memory.context.pins"),
              pkg.sections?.pins ?? [],
              "memory-context-pins",
            )}
          </div>
          <h3>{t("memory.context.continuation")}</h3>
          {pkg.sections?.continuation ? (
            <p data-testid="memory-context-continuation">
              {pkg.sections.continuation}
            </p>
          ) : (
            <p className="muted">{t("memory.context.noContinuation")}</p>
          )}
          {pkg.continuation_note && (
            <button
              className="link-button"
              onClick={() => onSelectNote(pkg.continuation_note!.note_id)}
            >
              {t("memory.context.continuationNote")}:{" "}
              {pkg.continuation_note.note_id.slice(0, 12)}
            </button>
          )}
          <h3>{t("memory.context.cards")}</h3>
          {(pkg.cards ?? []).length === 0 ? (
            <p className="muted">{t("memory.context.empty")}</p>
          ) : (
            <ul className="memory-cards" data-testid="memory-context-cards">
              {(pkg.cards ?? []).map(renderCard)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
