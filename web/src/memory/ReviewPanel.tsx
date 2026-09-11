import { useState } from "react";
import { useLang } from "../i18n/lang";
import { ErrorNotice, Status, date, useResource } from "../ui";
import {
  type MemoryCandidate,
  type MemoryCuratorStatus,
  type MemoryProposal,
} from "./api";

/**
 * Issue #37 (M04) phase B: read-only review surface. Curator proposals and
 * open candidate/conflict rows are listed; applying or rejecting a proposal
 * belongs to M06-B, so this view never mutates.
 */
export function ReviewPanel({
  spaceId,
  onSelectNote,
}: {
  spaceId: string;
  onSelectNote: (noteId: string) => void;
}) {
  const { t, lang, st } = useLang();
  const [state, setState] = useState("proposed");
  const [conflictState, setConflictState] = useState("candidate");
  const curator = useResource<MemoryCuratorStatus>(
    "/api/memory/curator/status",
  );
  const proposals = useResource<{
    items: MemoryProposal[];
    next: string | null;
  }>(
    `/api/memory/curator/proposals?space_id=${encodeURIComponent(spaceId)}` +
      `${state ? `&state=${state}` : ""}&limit=20`,
  );
  const conflicts = useResource<{
    items: MemoryCandidate[];
    next: string | null;
  }>(
    `/api/memory/conflicts?space_id=${encodeURIComponent(spaceId)}` +
      `${conflictState ? `&state=${conflictState}` : ""}&limit=20`,
  );
  const status = curator.data;
  return (
    <section
      className="memory-review-panel"
      aria-label={t("memory.review.title")}
    >
      <h2>{t("memory.review.title")}</h2>
      <p className="subtitle">{t("memory.review.subtitle")}</p>
      <ErrorNotice
        message={curator.error || proposals.error || conflicts.error}
      />
      <h3>{t("memory.review.curator")}</h3>
      {status ? (
        <div className="memory-facts">
          <div>
            <dt>{t("memory.review.mode")}</dt>
            <dd>
              <Status value={status.mode} />
            </dd>
          </div>
          <div>
            <dt>{t("memory.review.modelReady")}</dt>
            <dd>
              {status.model_ready
                ? t("memory.review.modelReady")
                : t("memory.review.modelMissing")}
            </dd>
          </div>
          <div>
            <dt>{t("memory.review.extractor")}</dt>
            <dd className="mono">{status.extractor_version}</dd>
          </div>
          <div>
            <dt>{t("memory.review.policy")}</dt>
            <dd className="mono">{status.policy_version}</dd>
          </div>
        </div>
      ) : (
        <p className="loading" role="status">
          {t("memory.list.loading")}
        </p>
      )}
      <p className="muted">
        <small>{t("memory.review.readOnly")}</small>
      </p>
      <div className="toolbar">
        <label>
          {t("memory.review.stateFilter")}
          <select
            data-testid="memory-review-state"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="">{t("memory.review.allStates")}</option>
            {["proposed", "shadow", "applied", "rejected", "stale"].map(
              (value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      <h3>{t("memory.review.proposals")}</h3>
      {(proposals.data?.items ?? []).length === 0 ? (
        <p className="muted" data-testid="memory-review-empty">
          {t("memory.review.emptyProposals")}
        </p>
      ) : (
        <ul className="memory-cards" data-testid="memory-proposals">
          {proposals.data!.items.map((proposal) => (
            <li key={proposal.id}>
              <div className="memory-card-head">
                <span className="memory-chip">{proposal.operation}</span>
                <Status value={proposal.state} />
                {proposal.kind && (
                  <span className="memory-chip">{proposal.kind}</span>
                )}
                {proposal.risk && (
                  <span className="memory-chip memory-chip-dirty">
                    {proposal.risk}
                  </span>
                )}
              </div>
              <strong>
                {proposal.title ?? proposal.note_id ?? proposal.id}
              </strong>
              {proposal.rationale && <p>{proposal.rationale}</p>}
              <small>
                {t("memory.review.claimClass")}: {proposal.claim_class ?? "—"} ·{" "}
                {t("memory.review.target")}: {proposal.target_note_id ?? "—"} ·{" "}
                {date(proposal.created_at, lang)}
              </small>
              {proposal.note_id && (
                <button
                  className="link-button"
                  onClick={() => onSelectNote(proposal.note_id!)}
                >
                  {t("memory.review.openNote")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>{t("memory.review.conflicts")}</h3>
      <div className="toolbar">
        <label>
          {t("memory.review.stateFilter")}
          <select
            value={conflictState}
            onChange={(event) => setConflictState(event.target.value)}
          >
            <option value="">{t("memory.review.allStates")}</option>
            {[
              "candidate",
              "conflict",
              "applied",
              "rejected",
              "quarantined",
            ].map((value) => (
              <option key={value} value={value}>
                {st(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(conflicts.data?.items ?? []).length === 0 ? (
        <p className="muted" data-testid="memory-review-no-conflicts">
          {t("memory.review.noConflicts")}
        </p>
      ) : (
        <ul
          className="memory-conflict-list"
          data-testid="memory-review-conflicts"
        >
          {conflicts.data!.items.map((candidate) => (
            <li key={candidate.id}>
              <Status value={candidate.state} />
              <span className="mono">{candidate.path}</span>
              {candidate.reason && <small> · {candidate.reason}</small>}
              {candidate.note_id && (
                <button
                  className="link-button"
                  onClick={() => onSelectNote(candidate.note_id!)}
                >
                  {t("memory.review.openNote")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
