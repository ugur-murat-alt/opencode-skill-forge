import { describe, expect, test } from "bun:test";
import { graphEdgeKey, layoutGraph } from "../web/src/memory/graph-layout.js";
import type { MemoryGraph } from "../web/src/memory/api.js";

function node(
  noteId: string,
  depth: number,
  title = noteId,
  kind = "note",
): MemoryGraph["nodes"][number] {
  return {
    note_id: noteId,
    space_id: "space-1",
    revision: 1,
    title,
    kind,
    depth,
    pinned: false,
  };
}

const graph: MemoryGraph = {
  origin: { note_id: "center", space_id: "space-1", revision: 3 },
  nodes: [
    node("center", 0, "Merkez", "task"),
    node("b", 1, "Beta"),
    node("a", 1, "Alfa", "decision"),
    node("d", 2, "Derin"),
    node("c", 2, "Ceviz"),
  ],
  edges: [
    { source_note_id: "center", relation: "SUPPORTS", target_note_id: "a" },
    { source_note_id: "center", relation: "ABOUT", target_note_id: "b" },
    { source_note_id: "a", relation: "DEPENDS_ON", target_note_id: "d" },
    { source_note_id: "b", relation: "PART_OF", target_note_id: "c" },
  ],
  truncated: false,
};

describe("issue #37 subgraph layout", () => {
  test("the origin stays at the center and depths are ringed", () => {
    const layout = layoutGraph(graph);
    expect(layout.origin).toEqual({ x: 0.5, y: 0.5 });
    const depthOne = layout.nodes.filter((row) => row.depth === 1);
    const depthTwo = layout.nodes.filter((row) => row.depth === 2);
    expect(depthOne).toHaveLength(2);
    expect(depthTwo).toHaveLength(2);
    for (const row of layout.nodes) {
      expect(row.x).toBeGreaterThanOrEqual(0.02);
      expect(row.x).toBeLessThanOrEqual(0.98);
      expect(row.y).toBeGreaterThanOrEqual(0.02);
      expect(row.y).toBeLessThanOrEqual(0.98);
    }
    const radius = (row: { x: number; y: number }) =>
      Math.hypot(row.x - 0.5, row.y - 0.5);
    expect(radius(depthOne[0]!)).toBeLessThan(radius(depthTwo[0]!) + 0.001);
    expect(radius(depthTwo[0]!)).toBeGreaterThan(radius(depthOne[0]!));
  });

  test("the same response always produces the same geometry", () => {
    const first = layoutGraph(graph);
    const second = layoutGraph(graph);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("ordering is stable by depth, kind, title and id", () => {
    const layout = layoutGraph(graph);
    expect(layout.nodes.map((row) => row.note_id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("an empty graph yields only the center anchor", () => {
    const layout = layoutGraph({
      origin: graph.origin,
      nodes: [node("center", 0)],
      edges: [],
      truncated: false,
    });
    expect(layout.nodes).toHaveLength(0);
    expect(layout.maxDepth).toBe(0);
  });

  test("edge identity is stable and collision free", () => {
    const key = graphEdgeKey(graph.edges[0]!);
    expect(key).toBe("center\u0000SUPPORTS\u0000a");
    expect(new Set(graph.edges.map((edge) => graphEdgeKey(edge))).size).toBe(
      graph.edges.length,
    );
  });
});
