import { useState } from "react";
import { errorCode } from "../api";
import { useLang } from "../i18n/lang";
import { ErrorNotice, date } from "../ui";
import {
  MEMORY_KIND_OPTIONS,
  memoryRecall,
  type MemoryRecallPage,
  type MemorySearchCard,
} from "./api";

/**
 * Issue #37 (M04) phase B: bounded lexical recall over accepted revisions.
 * Cards carry the match reason, sources and stale state; the cursor is
 * followed only through the explicit "more" action.
 */
export function SearchPanel({
  spaceId,
  onSelectNote,
}: {
  spaceId: string;
  onSelectNote: (noteId: string) => void;
}) {
  const { t, lang } = useLang();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [graphDepth, setGraphDepth] = useState(1);
  const [asOf, setAsOf] = useState("");
  const [page, setPage] = useState<MemoryRecallPage | null>(null);
  const [items, setItems] = useState<MemorySearchCard[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

  async function search(cursor?: string) {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await memoryRecall({
        query: query.trim(),
        spaceId,
        kinds: kind ? [kind] : undefined,
        graphDepth,
        limit: 8,
        cursor,
        asOf: asOf ? new Date(asOf).toISOString() : undefined,
      });
      if (cursor) setItems((current) => [...current, ...result.items]);
      else setItems(result.items);
      setPage(result);
      setSearched(true);
    } catch (caught) {
      setError(errorCode(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="memory-search-panel"
      aria-label={t("memory.search.title")}
    >
      <h2>{t("memory.search.title")}</h2>
      <p className="subtitle">{t("memory.search.subtitle")}</p>
      <form
        className="toolbar memory-search-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="search-field">
          {t("memory.search.placeholder")}
          <input
            data-testid="memory-search-input"
            value={query}
            placeholder={t("memory.search.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          {t("memory.search.kind")}
          <select
            data-testid="memory-search-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">{t("memory.search.allKinds")}</option>
            {MEMORY_KIND_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("memory.search.graphDepth")}
          <select
            value={graphDepth}
            onChange={(event) => setGraphDepth(Number(event.target.value))}
          >
            <option value={0}>0</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
        <label>
          {t("memory.search.asOf")}
          <input
            type="datetime-local"
            data-testid="memory-search-asof"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />
        </label>
        <button
          className="primary"
          data-testid="memory-search-submit"
          disabled={busy}
        >
          {busy ? t("memory.search.searching") : t("memory.search.submit")}
        </button>
      </form>
      <p className="muted">
        <small>{t("memory.search.asOfHint")}</small>
      </p>
      <ErrorNotice message={error} />
      {searched && items.length === 0 && (
        <p className="muted" data-testid="memory-search-empty">
          {t("memory.search.empty")}
        </p>
      )}
      {page && (
        <p className="memory-search-index" data-testid="memory-search-index">
          {t("memory.search.index")}: {t("memory.search.staleCount")}{" "}
          {page.index.stale} · {t("memory.search.pendingEvents")}{" "}
          {page.index.pending_events}
          {page.index.indexed_at !== null
            ? ` · ${t("memory.search.lastIndexed")}: ${date(page.index.indexed_at, lang)}`
            : ""}
        </p>
      )}
      <ul className="memory-cards" data-testid="memory-search-results">
        {items.map((card) => (
          <li key={`${card.space_id}\u0000${card.note_id}`}>
            <div className="memory-card-head">
              <strong>{card.title}</strong>
              <span className="memory-chip">{card.kind}</span>
              <span className="mono">
                {t("memory.search.score")} {card.score.toFixed(3)}
              </span>
              {card.pinned && (
                <span className="memory-chip">{t("memory.list.pinned")}</span>
              )}
              {card.stale && (
                <span className="memory-chip memory-chip-error">stale</span>
              )}
            </div>
            <p className="memory-card-snippet">{card.snippet}</p>
            <small>
              {t("memory.search.matchReason")}: {card.match_reason.join(", ")}
            </small>
            <div className="toolbar">
              <small>
                {t("memory.search.verified")}: {card.verification}
              </small>
              <button
                className="link-button"
                data-testid="memory-search-open"
                onClick={() => onSelectNote(card.note_id)}
              >
                {t("memory.search.open")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {page?.next && (
        <button
          data-testid="memory-search-more"
          disabled={busy}
          onClick={() => void search(page.next!)}
        >
          {t("memory.search.more")}
        </button>
      )}
    </section>
  );
}
