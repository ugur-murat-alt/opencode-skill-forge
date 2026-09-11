import { useMemo, useState } from "react";
import { errorCode } from "../api";
import { useLang } from "../i18n/lang";
import { ErrorNotice, useResource } from "../ui";
import {
  MEMORY_RELATIONS,
  memoryLink,
  type MemoryGraph,
  type MemoryNote,
  type MemoryNoteDetail,
} from "./api";
import { graphEdgeKey, layoutGraph } from "./graph-layout";

/**
 * Issue #37 (M04) phase B: bounded subgraph around the selected note plus a
 * keyboard-navigable relationship list (the accessible alternative). The
 * typed relation edit updates the source note's versioned metadata; there is
 * no second graph writer.
 */
export function GraphView({
  spaceId,
  detail,
  notes,
  canWrite,
  onSelectNote,
  onChanged,
}: {
  spaceId: string;
  detail: MemoryNoteDetail | null;
  notes: MemoryNote[];
  canWrite: boolean;
  onSelectNote: (noteId: string) => void;
  onChanged: () => void;
}) {
  const { t, err } = useLang();
  const [depth, setDepth] = useState(2);
  const [maxNodes, setMaxNodes] = useState(25);
  const [maxEdges, setMaxEdges] = useState(50);
  const [kindFilter, setKindFilter] = useState("");
  const [relationFilter, setRelationFilter] = useState("");
  const [linkRelation, setLinkRelation] = useState<string>(MEMORY_RELATIONS[0]);
  const [linkTarget, setLinkTarget] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [removing, setRemoving] = useState("");
  const noteId = detail?.note.id ?? "";
  const graph = useResource<MemoryGraph>(
    noteId
      ? `/api/memory/graph?space_id=${encodeURIComponent(spaceId)}` +
          `&note_id=${encodeURIComponent(noteId)}` +
          `&depth=${depth}&max_nodes=${maxNodes}&max_edges=${maxEdges}`
      : null,
  );
  const graphData = graph.data;
  const layout = useMemo(
    () =>
      graphData
        ? layoutGraph(graphData)
        : { nodes: [], origin: { x: 0.5, y: 0.5 }, maxDepth: 0 },
    [graphData],
  );
  const kindOptions = useMemo(
    () =>
      [...new Set(layout.nodes.map((node) => node.kind))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [layout.nodes],
  );
  const relationOptions = useMemo(
    () =>
      [...new Set((graphData?.edges ?? []).map((edge) => edge.relation))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [graphData],
  );
  const visibleNodes = layout.nodes.filter(
    (node) => !kindFilter || node.kind === kindFilter,
  );
  const visibleIds = new Set(visibleNodes.map((node) => node.note_id));
  // The selected note stays the visible center even while filtering.
  visibleIds.add(noteId);
  const visibleEdges = (graphData?.edges ?? []).filter(
    (edge) =>
      (!relationFilter || edge.relation === relationFilter) &&
      visibleIds.has(edge.source_note_id) &&
      visibleIds.has(edge.target_note_id),
  );
  const nodeByKey = new Map(
    layout.nodes.map((node) => [`${node.space_id}\u0000${node.note_id}`, node]),
  );
  const positionOf = (target: string) => {
    if (target === noteId) return layout.origin;
    const node = [...nodeByKey.values()].find((row) => row.note_id === target);
    return node ? { x: node.x, y: node.y } : null;
  };
  const currentRevision = detail?.revision?.revision ?? null;
  const readOnlyNote =
    !canWrite || !currentRevision || Boolean(detail?.note.deleted_at);

  async function addLink() {
    if (!noteId || !currentRevision || !linkTarget || linkBusy) return;
    setLinkBusy(true);
    setLinkError("");
    try {
      await memoryLink({
        spaceId,
        noteId,
        relation: linkRelation,
        targetNoteId: linkTarget,
        expectedRevision: currentRevision,
      });
      setLinkTarget("");
      graph.refresh();
      onChanged();
    } catch (caught) {
      setLinkError(err(errorCode(caught)));
      if (errorCode(caught) === "memory_revision_conflict") onChanged();
    } finally {
      setLinkBusy(false);
    }
  }

  async function removeLink(
    sourceNoteId: string,
    relation: string,
    targetNoteId: string,
  ) {
    const key = `${sourceNoteId}\u0000${relation}\u0000${targetNoteId}`;
    if (!noteId || !currentRevision || removing) return;
    setRemoving(key);
    setLinkError("");
    try {
      await memoryLink({
        spaceId,
        noteId: sourceNoteId,
        relation,
        targetNoteId,
        remove: true,
        expectedRevision:
          sourceNoteId === noteId
            ? currentRevision
            : (nodeByKey.get(`${spaceId}\u0000${sourceNoteId}`)?.revision ?? 0),
      });
      graph.refresh();
      onChanged();
    } catch (caught) {
      setLinkError(err(errorCode(caught)));
      if (errorCode(caught) === "memory_revision_conflict") onChanged();
    } finally {
      setRemoving("");
    }
  }

  if (!noteId) return null;
  const relations = [...visibleEdges].sort((a, b) =>
    graphEdgeKey(a).localeCompare(graphEdgeKey(b)),
  );
  return (
    <section className="memory-graph" aria-label={t("memory.graph.title")}>
      <div className="toolbar memory-graph-toolbar">
        <label>
          {t("memory.graph.depth")}
          <select
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
        <label>
          {t("memory.graph.kindFilter")}
          <select
            data-testid="memory-graph-kind"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            <option value="">{t("memory.graph.allKinds")}</option>
            {kindOptions.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("memory.graph.relationFilter")}
          <select
            data-testid="memory-graph-relation"
            value={relationFilter}
            onChange={(event) => setRelationFilter(event.target.value)}
          >
            <option value="">{t("memory.graph.allRelations")}</option>
            {relationOptions.map((relation) => (
              <option key={relation} value={relation}>
                {relation}
              </option>
            ))}
          </select>
        </label>
        <span className="memory-chip" data-testid="memory-graph-counts">
          {t("memory.graph.counts", {
            nodes: visibleNodes.length + 1,
            edges: visibleEdges.length,
          })}
        </span>
      </div>
      {(kindFilter || relationFilter) && (
        <p className="muted">
          <small>{t("memory.graph.filteredHint")}</small>
        </p>
      )}
      <ErrorNotice message={graph.error || linkError} />
      {graph.loading && !graphData ? (
        <p className="loading" role="status">
          {t("memory.graph.loading")}
        </p>
      ) : !graphData ? null : (
        <>
          <svg
            className="memory-graph-canvas"
            viewBox="0 0 100 60"
            role="img"
            aria-label={t("memory.graph.title")}
            data-testid="memory-graph-canvas"
          >
            {relations.map((edge) => {
              const from = positionOf(edge.source_note_id);
              const to = positionOf(edge.target_note_id);
              if (!from || !to) return null;
              return (
                <g key={graphEdgeKey(edge)}>
                  <line
                    x1={from.x * 100}
                    y1={from.y * 60}
                    x2={to.x * 100}
                    y2={to.y * 60}
                    className="memory-graph-edge"
                  />
                  <text
                    x={((from.x + to.x) / 2) * 100}
                    y={((from.y + to.y) / 2) * 60 - 0.8}
                    className="memory-graph-edge-label"
                    textAnchor="middle"
                  >
                    {edge.relation}
                  </text>
                </g>
              );
            })}
            <g
              transform={`translate(${layout.origin.x * 100} ${layout.origin.y * 60})`}
              className="memory-graph-origin"
            >
              <circle r={3.6} />
              <text
                y={-0.4}
                textAnchor="middle"
                className="memory-graph-node-title"
              >
                {(detail?.note.title ?? "").slice(0, 22)}
              </text>
              <text
                y={2.4}
                textAnchor="middle"
                className="memory-graph-node-kind"
              >
                {detail?.revision?.kind ?? "note"} · {t("memory.graph.center")}
              </text>
            </g>
            {visibleNodes.map((node) => (
              <g
                key={`${node.space_id}\u0000${node.note_id}`}
                transform={`translate(${node.x * 100} ${node.y * 60})`}
                className="memory-graph-node"
                role="button"
                tabIndex={0}
                aria-label={`${node.title} (${node.kind})`}
                onClick={() => onSelectNote(node.note_id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectNote(node.note_id);
                  }
                }}
              >
                <circle r={3.1} />
                <text
                  y={-0.4}
                  textAnchor="middle"
                  className="memory-graph-node-title"
                >
                  {node.title.slice(0, 18)}
                </text>
                <text
                  y={2.2}
                  textAnchor="middle"
                  className="memory-graph-node-kind"
                >
                  {node.kind}
                  {node.pinned ? ` · ${t("memory.graph.pinnedMark")}` : ""}
                </text>
              </g>
            ))}
          </svg>
          {graphData.truncated && (
            <p className="memory-banner" data-testid="memory-graph-truncated">
              {t("memory.graph.truncated")}
            </p>
          )}
          <div className="toolbar">
            {depth < 2 && (
              <button
                onClick={() => setDepth((value) => Math.min(2, value + 1))}
              >
                {t("memory.graph.moreDepth")}
              </button>
            )}
            {maxNodes < 50 && (
              <button
                data-testid="memory-graph-more"
                onClick={() => {
                  setMaxNodes((value) => Math.min(50, value + 25));
                  setMaxEdges((value) => Math.min(100, value + 50));
                }}
              >
                {t("memory.graph.moreNodes")}
              </button>
            )}
          </div>
          <h3>{t("memory.graph.title")}</h3>
          {relations.length === 0 ? (
            <p className="muted" data-testid="memory-graph-empty">
              {t("memory.graph.empty")}
            </p>
          ) : (
            <ul className="memory-relations" data-testid="memory-relations">
              {relations.map((edge) => {
                const outgoing = edge.source_note_id === noteId;
                const otherId = outgoing
                  ? edge.target_note_id
                  : edge.source_note_id;
                const other = nodeByKey.get(`${spaceId}\u0000${otherId}`);
                const label =
                  other?.title ??
                  (otherId === noteId ? (detail?.note.title ?? "") : otherId);
                return (
                  <li key={graphEdgeKey(edge)}>
                    <span className="memory-chip">{edge.relation}</span>
                    <span className="memory-chip">
                      {outgoing
                        ? t("memory.graph.outgoing")
                        : t("memory.graph.incoming")}
                    </span>
                    <span>{label}</span>
                    {other && <small>{other.kind}</small>}
                    <button
                      className="link-button"
                      data-testid="memory-relations-open"
                      onClick={() => onSelectNote(otherId)}
                    >
                      {t("memory.graph.open")}
                    </button>
                    {outgoing && !readOnlyNote && (
                      <button
                        className="link-button"
                        data-testid="memory-relations-remove"
                        disabled={removing !== ""}
                        onClick={() =>
                          void removeLink(
                            edge.source_note_id,
                            edge.relation,
                            edge.target_note_id,
                          )
                        }
                      >
                        {removing ===
                        `${edge.source_note_id}\u0000${edge.relation}\u0000${edge.target_note_id}`
                          ? t("memory.graph.removing")
                          : t("memory.graph.remove")}
                      </button>
                    )}
                    {!outgoing && (
                      <>
                        <small>{t("memory.graph.sourceOwner")}</small>
                        <button
                          className="link-button"
                          onClick={() => onSelectNote(edge.source_note_id)}
                        >
                          {t("memory.graph.goToSource")}
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!readOnlyNote && (
            <details className="memory-link-add">
              <summary>{t("memory.graph.addTitle")}</summary>
              <p>
                <small>{t("memory.graph.addHint")}</small>
              </p>
              <label>
                {t("memory.graph.relationLabel")}
                <select
                  data-testid="memory-link-relation"
                  value={linkRelation}
                  onChange={(event) => setLinkRelation(event.target.value)}
                >
                  {MEMORY_RELATIONS.map((relation) => (
                    <option key={relation} value={relation}>
                      {relation}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("memory.graph.target")}
                <select
                  data-testid="memory-link-target"
                  value={linkTarget}
                  onChange={(event) => setLinkTarget(event.target.value)}
                >
                  <option value="">—</option>
                  {notes
                    .filter((note) => note.id !== noteId)
                    .map((note) => (
                      <option key={note.id} value={note.id}>
                        {note.title}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="primary"
                data-testid="memory-link-add"
                disabled={linkBusy || !linkTarget}
                onClick={() => void addLink()}
              >
                {linkBusy ? t("memory.graph.adding") : t("memory.graph.add")}
              </button>
            </details>
          )}
        </>
      )}
    </section>
  );
}
