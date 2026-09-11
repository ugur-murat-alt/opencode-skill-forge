import type { MemoryGraph, MemoryGraphNode } from "./api";

/**
 * Issue #37 (M04) phase B: deterministic subgraph layout. The origin sits at
 * the center, neighbors are placed on depth rings in a stable order, so the
 * same response always renders the same geometry (no random force layout).
 */

export interface LaidOutNode extends MemoryGraphNode {
  /** Unit-box position; the renderer maps it to the SVG viewBox. */
  x: number;
  y: number;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  /** Origin position in the same unit box. */
  origin: { x: number; y: number };
  maxDepth: number;
}

const RING_RADIUS = [0, 0.3, 0.46] as const;

export function layoutGraph(
  graph: MemoryGraph,
  width = 0.9,
  height = 0.9,
): GraphLayout {
  const origin = { x: 0.5, y: 0.5 };
  const nodes = [...graph.nodes].sort(
    (a, b) =>
      a.depth - b.depth ||
      a.kind.localeCompare(b.kind) ||
      a.title.localeCompare(b.title) ||
      a.note_id.localeCompare(b.note_id),
  );
  const byDepth = new Map<number, MemoryGraphNode[]>();
  let maxDepth = 0;
  for (const node of nodes) {
    if (node.depth === 0) continue;
    maxDepth = Math.max(maxDepth, node.depth);
    const bucket = byDepth.get(node.depth) ?? [];
    bucket.push(node);
    byDepth.set(node.depth, bucket);
  }
  const laidOut: LaidOutNode[] = [];
  for (const [depth, bucket] of [...byDepth.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const radius = RING_RADIUS[Math.min(depth, RING_RADIUS.length - 1)]!;
    const step = (Math.PI * 2) / Math.max(bucket.length, 1);
    const offset = depth % 2 === 0 ? step / 2 : 0;
    bucket.forEach((node, index) => {
      const angle = -Math.PI / 2 + offset + index * step;
      laidOut.push({
        ...node,
        x: clamp(origin.x + Math.cos(angle) * radius * width),
        y: clamp(origin.y + Math.sin(angle) * radius * height),
      });
    });
  }
  return { nodes: laidOut, origin, maxDepth };
}

function clamp(value: number): number {
  return Math.min(0.98, Math.max(0.02, value));
}

/** Stable identity for an edge row. */
export function graphEdgeKey(edge: MemoryGraph["edges"][number]): string {
  return `${edge.source_note_id}\u0000${edge.relation}\u0000${edge.target_note_id}`;
}
