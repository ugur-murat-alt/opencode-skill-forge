import { useLang } from "../i18n/lang";
import { Status, date } from "../ui";
import type {
  MemoryCandidate,
  MemoryNoteDetail,
  MemoryRevision,
  MemorySourceRow,
} from "./api";

/**
 * Issue #37 (M04) phase A: read-only source panel. It shows the accepted
 * revision metadata, the note/source binding (read-only file versus managed
 * copy), canonical source references and open candidate/conflict rows.
 */

interface SourceReference {
  id?: unknown;
  kind?: unknown;
  revision?: unknown;
  hash?: unknown;
  url?: unknown;
}

function parseSources(raw: string | undefined): SourceReference[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SourceReference =>
        typeof entry === "object" && entry !== null,
    );
  } catch {
    return [];
  }
}

function text(value: unknown): string {
  return typeof value === "string" && value ? value : "—";
}

function shortHash(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 16 ? `${value.slice(0, 12)}…` : value;
}

export function SourcePanel({
  detail,
  sources,
  conflicts,
  revisions,
  onViewRevision,
  onBackToCurrent,
  viewingRevision,
  onMoreRevisions,
  hasMoreRevisions,
}: {
  detail: MemoryNoteDetail | null;
  sources: MemorySourceRow[];
  conflicts: MemoryCandidate[];
  revisions: MemoryRevision[];
  onViewRevision: (revision: MemoryRevision) => void;
  onBackToCurrent: () => void;
  viewingRevision: number | null;
  onMoreRevisions: () => void;
  hasMoreRevisions: boolean;
}) {
  const { t, lang } = useLang();
  const note = detail?.note ?? null;
  const revision = detail?.revision ?? null;
  const bound = note?.source_id
    ? sources.find((source) => source.id === note.source_id)
    : null;
  const references = parseSources(revision?.sources_json);
  return (
    <section
      className="panel memory-source"
      aria-label={t("memory.source.title")}
    >
      <h2>{t("memory.source.title")}</h2>
      {!note || !revision ? (
        <p className="loading" role="status">
          {t("shell.loading")}
        </p>
      ) : (
        <>
          <p className="memory-source-kind" data-testid="memory-source-binding">
            {note.source_id
              ? t("memory.source.bound")
              : t("memory.source.managed")}
          </p>
          <dl className="memory-facts">
            <div>
              <dt>{t("memory.source.revision")}</dt>
              <dd className="mono" data-testid="memory-source-revision">
                {revision.revision}
              </dd>
            </div>
            <div>
              <dt>{t("memory.source.contentHash")}</dt>
              <dd className="mono" title={revision.content_hash ?? ""}>
                {shortHash(revision.content_hash)}
              </dd>
            </div>
            <div>
              <dt>{t("memory.source.byteSize")}</dt>
              <dd>{revision.byte_size ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("memory.source.baseRevision")}</dt>
              <dd className="mono">{revision.base_revision ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("memory.source.createdAt")}</dt>
              <dd>{date(revision.created_at, lang)}</dd>
            </div>
            <div>
              <dt>{t("memory.source.createdBy")}</dt>
              <dd className="mono">{revision.created_by.slice(0, 8)}</dd>
            </div>
          </dl>
          {note.source_id && (
            <dl className="memory-facts">
              <div>
                <dt>{t("memory.source.sourcePath")}</dt>
                <dd className="mono">{note.source_path ?? "—"}</dd>
              </div>
              <div>
                <dt>{t("memory.source.sourceMode")}</dt>
                <dd>
                  {bound
                    ? bound.mode === "read_only"
                      ? t("memory.source.readOnly")
                      : t("memory.source.managedMode")
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>{t("memory.source.sourceState")}</dt>
                <dd>
                  <Status value={note.source_state} />
                </dd>
              </div>
              <div>
                <dt>{t("memory.source.sourceHash")}</dt>
                <dd className="mono" title={note.source_hash ?? ""}>
                  {shortHash(note.source_hash)}
                </dd>
              </div>
            </dl>
          )}
          <h3>{t("memory.source.canonical")}</h3>
          {references.length === 0 ? (
            <p className="muted">{t("memory.source.noSources")}</p>
          ) : (
            <ul className="memory-source-list">
              {references.map((reference, index) => (
                <li key={`${text(reference.id)}-${index}`}>
                  <span className="mono">{text(reference.id)}</span>
                  {reference.kind !== undefined && (
                    <small> · {text(reference.kind)}</small>
                  )}
                  {typeof reference.hash === "string" && (
                    <small className="mono" title={reference.hash}>
                      {" "}
                      · {shortHash(reference.hash)}
                    </small>
                  )}
                  {typeof reference.url === "string" && (
                    <small className="mono"> · {reference.url}</small>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h3>{t("memory.source.conflicts")}</h3>
          {conflicts.length === 0 ? (
            <p className="muted" data-testid="memory-no-conflicts">
              {t("memory.source.noConflicts")}
            </p>
          ) : (
            <ul className="memory-conflict-list" data-testid="memory-conflicts">
              {conflicts.map((candidate) => (
                <li key={candidate.id}>
                  <Status value={candidate.state} />
                  <span className="mono">{candidate.path}</span>
                  {candidate.reason && <small> · {candidate.reason}</small>}
                  {candidate.base_revision !== null && (
                    <small>
                      {" "}
                      · {t("memory.source.baseRevision")}:{" "}
                      {candidate.base_revision}
                    </small>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h3>{t("memory.history.title")}</h3>
          {viewingRevision !== null && (
            <button
              className="link-button"
              data-testid="memory-history-back"
              onClick={onBackToCurrent}
            >
              {t("memory.history.backToCurrent")}
            </button>
          )}
          {revisions.length === 0 ? (
            <p className="muted">{t("memory.history.empty")}</p>
          ) : (
            <ul className="memory-history" data-testid="memory-history">
              {revisions.map((row) => (
                <li
                  key={row.revision}
                  aria-current={
                    viewingRevision === row.revision ? "true" : undefined
                  }
                >
                  <span className="mono">
                    {t("memory.note.revision", { revision: row.revision })}
                  </span>
                  <small>{date(row.created_at, lang)}</small>
                  <small className="mono">{shortHash(row.content_hash)}</small>
                  <button
                    className="link-button"
                    data-testid="memory-view-revision"
                    disabled={viewingRevision === row.revision}
                    onClick={() => onViewRevision(row)}
                  >
                    {t("memory.history.view")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hasMoreRevisions && (
            <button className="link-button" onClick={onMoreRevisions}>
              {t("memory.list.more")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
