import { useState } from "react";
import { ApiError, errorCode } from "../api";
import { useLang } from "../i18n/lang";
import { ErrorNotice, Status, date, useResource } from "../ui";
import {
  memoryApproveProposal,
  memoryRejectProposal,
  type MemoryCandidate,
  type MemoryCuratorStatus,
  type MemoryProposal,
} from "./api";

/**
 * Issue #39 (M06) phase B: proposal review becomes actionable.
 *
 * Approval/rejection are explicit human decisions: a write goes through the
 * M02 commit path with CAS, a rejection only records the decision. Shadow
 * rows are evaluation records and applied rows are already durable, so both
 * stay read-only. Stale rows expose their reason and cannot be approved.
 */

interface SourceReference {
  source_id?: unknown;
  path?: unknown;
  section?: unknown;
  hash?: unknown;
}

function parseReferences(raw: string | undefined): SourceReference[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is SourceReference =>
            typeof entry === "object" && entry !== null,
        )
      : [];
  } catch {
    return [];
  }
}

function text(value: unknown): string {
  return typeof value === "string" && value ? value : "—";
}

function shortHash(value: unknown): string {
  return typeof value === "string" && value
    ? value.length > 12
      ? `${value.slice(0, 12)}…`
      : value
    : "—";
}

export function ReviewPanel({
  spaceId,
  onSelectNote,
  onChanged,
}: {
  spaceId: string;
  onSelectNote: (noteId: string) => void;
  onChanged?: () => void;
}) {
  const { t, st, lang } = useLang();
  const [state, setState] = useState("proposed");
  const [conflictState, setConflictState] = useState("candidate");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{
    current: number | null;
    base: number | null;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [rejecting, setRejecting] = useState("");
  const [rejectReason, setRejectReason] = useState("");
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

  function handleDecisionError(caught: unknown, refresh: () => void) {
    const code = errorCode(caught);
    setError(code);
    if (code === "memory_revision_conflict" && caught instanceof ApiError) {
      const detail = (caught.detail ?? {}) as {
        current_revision?: number;
        base_revision?: number;
        expected_revision?: number;
      };
      setConflict({
        current: detail.current_revision ?? null,
        base: detail.base_revision ?? detail.expected_revision ?? null,
      });
    }
    refresh();
    onChanged?.();
  }

  async function approve(proposal: MemoryProposal) {
    if (busyId) return;
    setBusyId(proposal.id);
    setError("");
    setNotice("");
    setConflict(null);
    try {
      const result = await memoryApproveProposal({
        spaceId,
        changeId: proposal.id,
        expectedRevision: proposal.base_revision ?? undefined,
      });
      setNotice(
        result.revision !== null
          ? `${t("memory.review.approved")} ${t("memory.note.revision", { revision: result.revision })}`
          : t("memory.review.approved"),
      );
      proposals.refresh();
      onChanged?.();
    } catch (caught) {
      handleDecisionError(caught, () => void proposals.refresh());
    } finally {
      setBusyId("");
    }
  }

  async function reject(proposal: MemoryProposal) {
    if (busyId) return;
    setBusyId(proposal.id);
    setError("");
    setNotice("");
    setConflict(null);
    try {
      await memoryRejectProposal({
        spaceId,
        changeId: proposal.id,
        reason: rejectReason.trim() || undefined,
      });
      setNotice(t("memory.review.rejected"));
      setRejecting("");
      setRejectReason("");
      proposals.refresh();
    } catch (caught) {
      handleDecisionError(caught, () => void proposals.refresh());
    } finally {
      setBusyId("");
    }
  }

  function renderProposal(proposal: MemoryProposal) {
    const readonly =
      proposal.state === "applied" ||
      proposal.state === "shadow" ||
      proposal.state === "rejected";
    const stale = proposal.state === "stale";
    const userDecision =
      proposal.claim_class !== "user_declaration" &&
      proposal.claim_class !== "link";
    const references = parseReferences(proposal.source_refs_json);
    return (
      <li key={proposal.id} data-testid="memory-proposal">
        <div className="memory-card-head">
          <span className="memory-chip">{proposal.operation}</span>
          <Status value={proposal.state} />
          {proposal.kind && (
            <span className="memory-chip">{proposal.kind}</span>
          )}
          <span className="memory-chip memory-chip-dirty">
            {t("memory.review.risk")}: {proposal.risk}
          </span>
          {userDecision && (
            <span
              className="memory-chip"
              data-testid="memory-proposal-user-decision"
            >
              {t("memory.review.userDecision")}
            </span>
          )}
          {proposal.state === "applied" && (
            <span
              className="memory-chip"
              data-testid="memory-proposal-applied-badge"
            >
              {proposal.mode === "auto"
                ? t("memory.review.appliedAuto")
                : t("memory.review.appliedManual")}
            </span>
          )}
        </div>
        <strong>{proposal.title ?? proposal.note_id ?? proposal.id}</strong>
        {proposal.rationale && <p>{proposal.rationale}</p>}
        <small>
          {t("memory.review.claimClass")}: {proposal.claim_class ?? "—"}
          {proposal.note_id
            ? ` · ${t("memory.review.target")}: ${proposal.note_id}`
            : ""}
          {proposal.base_revision !== null
            ? ` · ${t("memory.source.baseRevision")}: ${proposal.base_revision}`
            : ""}
          {proposal.relation
            ? ` · ${t("memory.graph.relation")}: ${proposal.relation} → ${proposal.target_note_id ?? "—"}`
            : ""}
          {" · "}
          {date(proposal.created_at, lang)}
        </small>
        {proposal.applied_revision !== null && (
          <small>
            {" "}
            {t("memory.review.appliedRevision")}: {proposal.applied_revision}
          </small>
        )}
        {(stale || proposal.state === "rejected") && proposal.reason && (
          <p className="memory-banner" data-testid="memory-proposal-stale">
            {proposal.state === "stale"
              ? `${t("memory.review.staleNote")} (${proposal.reason})`
              : `${t("memory.review.reason")}: ${proposal.reason}`}
          </p>
        )}
        {references.length > 0 && (
          <ul
            className="memory-source-list"
            data-testid="memory-proposal-sources"
          >
            {references.slice(0, 5).map((reference, index) => (
              <li key={index}>
                <span className="mono">{text(reference.source_id)}</span>
                {reference.path !== undefined && (
                  <small> · {text(reference.path)}</small>
                )}
                {reference.section !== undefined && (
                  <small> · {text(reference.section)}</small>
                )}
                <small className="mono"> · {shortHash(reference.hash)}</small>
              </li>
            ))}
          </ul>
        )}
        {proposal.note_id && (
          <button
            className="link-button"
            data-testid="memory-proposal-open"
            onClick={() => onSelectNote(proposal.note_id!)}
          >
            {t("memory.review.openNote")}
          </button>
        )}
        {!readonly && (
          <div className="toolbar memory-review-actions">
            <button
              className="primary"
              data-testid="memory-proposal-approve"
              disabled={busyId === proposal.id || stale}
              title={stale ? t("memory.review.staleNote") : undefined}
              onClick={() => void approve(proposal)}
            >
              {t("memory.review.approve")}
            </button>
            <button
              data-testid="memory-proposal-reject"
              disabled={busyId === proposal.id}
              onClick={() => {
                setRejecting(rejecting === proposal.id ? "" : proposal.id);
                setRejectReason("");
              }}
            >
              {t("memory.review.reject")}
            </button>
          </div>
        )}
        {proposal.state === "shadow" && (
          <p className="muted" data-testid="memory-proposal-shadow">
            <small>{t("memory.review.shadowReadOnly")}</small>
          </p>
        )}
        {rejecting === proposal.id && (
          <form
            className="memory-reject-form"
            onSubmit={(event) => {
              event.preventDefault();
              void reject(proposal);
            }}
          >
            <label>
              {t("memory.review.rejectReason")}
              <textarea
                rows={2}
                data-testid="memory-proposal-reason"
                value={rejectReason}
                placeholder={t("memory.review.rejectReasonPh")}
                onChange={(event) => setRejectReason(event.target.value)}
              />
            </label>
            <div className="toolbar">
              <button
                className="primary"
                data-testid="memory-proposal-reject-confirm"
                disabled={busyId === proposal.id}
              >
                {t("memory.review.rejectConfirm")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRejecting("");
                  setRejectReason("");
                }}
              >
                {t("memory.review.cancel")}
              </button>
            </div>
          </form>
        )}
      </li>
    );
  }

  return (
    <section
      className="memory-review-panel"
      aria-label={t("memory.review.title")}
    >
      <h2>{t("memory.review.title")}</h2>
      <p className="subtitle">{t("memory.review.subtitle")}</p>
      <ErrorNotice
        message={
          (error ? error : "") ||
          curator.error ||
          proposals.error ||
          conflicts.error
        }
      />
      {notice && (
        <p className="memory-notice" role="status">
          {notice}
        </p>
      )}
      {conflict && (
        <p
          className="memory-banner"
          role="alert"
          data-testid="memory-review-conflict"
        >
          <strong>{t("memory.review.conflictTitle")}</strong>{" "}
          {t("memory.review.conflictDetail", {
            base: conflict.base ?? "—",
            current: conflict.current ?? "—",
          })}
        </p>
      )}
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
            onChange={(event) => {
              setState(event.target.value);
              setRejecting("");
              setRejectReason("");
            }}
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
          {proposals.data!.items.map(renderProposal)}
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
