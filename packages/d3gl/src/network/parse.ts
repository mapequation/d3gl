/**
 * Edge-list ingestion (sub-issue #99 / epic #98).
 *
 * Maps arbitrary node labels to dense `0..n-1` indices in first-seen order,
 * so downstream SoA/CSR buffers (see {@link ./graph.js}) stay compact.
 */

export interface ParsedEdges {
  nodeCount: number;
  /** Directed edge endpoints as dense node indices. */
  source: Uint32Array;
  target: Uint32Array;
  /** Per-edge weight; defaults to 1 when no third column is present. */
  weight: Float32Array;
  /** Dense index → original node label. */
  labels: string[];
}

/**
 * Parse a whitespace-separated edge list: `source target [weight]` per line.
 * Blank lines and `#` comment lines are ignored.
 */
export function parseEdgeList(text: string): ParsedEdges {
  const index = new Map<string, number>();
  const labels: string[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];

  const intern = (label: string): number => {
    let id = index.get(label);
    if (id === undefined) {
      id = labels.length;
      index.set(label, id);
      labels.push(label);
    }
    return id;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 2) continue;
    source.push(intern(cols[0]!));
    target.push(intern(cols[1]!));
    weight.push(cols.length > 2 ? Number(cols[2]) : 1);
  }

  return {
    nodeCount: labels.length,
    source: Uint32Array.from(source),
    target: Uint32Array.from(target),
    weight: Float32Array.from(weight),
    labels,
  };
}
