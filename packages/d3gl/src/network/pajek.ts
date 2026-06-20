/**
 * Pajek `.net` ingestion (sub-issue #102 / epic #98).
 *
 * Supports the common sections: `*Vertices` (with optional quoted labels and layout coordinates),
 * `*Arcs` / `*Arcslist` (directed) and `*Edges` / `*Edgeslist` (undirected). Pajek vertex ids are
 * 1-based; they map to dense `0..n-1` indices here so the result drops straight into
 * {@link ./graph.js}'s `buildGraph`. Unknown sections (e.g. `*Matrix`) are skipped.
 */
import type { ParsedEdges } from "./parse.js";

export interface ParsedPajek extends ParsedEdges {
  /** True when the file declared `*Arcs` / `*Arcslist` (directed edges). */
  directed: boolean;
  /** Interleaved `[x, y, …]` layout coordinates from `*Vertices`, present only if any were given. */
  positions?: Float32Array;
}

type Section = "vertices" | "arcs" | "edges" | "arcslist" | "edgeslist" | "ignore";

/** Parse a Pajek `.net` document into a directed-or-undirected edge list (+ optional positions). */
export function parsePajek(text: string): ParsedPajek {
  const labels: string[] = [];
  const coords = new Map<number, [number, number]>();
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  let declaredN = 0;
  let maxId = 0;
  let directed = false;
  let section: Section = "ignore";

  const note = (id: number) => {
    if (id > maxId) maxId = id;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%")) continue;

    if (line.startsWith("*")) {
      const lower = line.toLowerCase();
      // Order matters: `*arcslist` / `*edgeslist` must be tested before `*arcs` / `*edges`.
      if (lower.startsWith("*vertices")) {
        section = "vertices";
        declaredN = Number.parseInt(line.split(/\s+/)[1] ?? "0", 10) || 0;
      } else if (lower.startsWith("*arcslist")) {
        section = "arcslist";
        directed = true;
      } else if (lower.startsWith("*edgeslist")) {
        section = "edgeslist";
      } else if (lower.startsWith("*arcs")) {
        section = "arcs";
        directed = true;
      } else if (lower.startsWith("*edges")) {
        section = "edges";
      } else {
        section = "ignore";
      }
      continue;
    }

    if (section === "vertices") {
      const m = /^(\d+)\s*(.*)$/.exec(line);
      if (!m) continue;
      const id = Number(m[1]);
      const rest = m[2]!;
      note(id);
      let label: string;
      let coordStr: string;
      if (rest.startsWith('"')) {
        const end = rest.indexOf('"', 1);
        label = end === -1 ? rest.slice(1) : rest.slice(1, end);
        coordStr = end === -1 ? "" : rest.slice(end + 1).trim();
      } else if (rest === "") {
        label = String(id);
        coordStr = "";
      } else {
        const parts = rest.split(/\s+/);
        label = parts[0]!;
        coordStr = parts.slice(1).join(" ");
      }
      labels[id - 1] = label;
      if (coordStr !== "") {
        const nums = coordStr.split(/\s+/).map(Number);
        const x = nums[0];
        const y = nums[1];
        if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
          coords.set(id - 1, [x, y]);
        }
      }
      continue;
    }

    if (section === "arcs" || section === "edges") {
      const cols = line.split(/\s+/);
      if (cols.length < 2) continue;
      const a = Number(cols[0]);
      const b = Number(cols[1]);
      note(a);
      note(b);
      source.push(a - 1);
      target.push(b - 1);
      weight.push(cols.length > 2 ? Number(cols[2]) : 1);
      continue;
    }

    if (section === "arcslist" || section === "edgeslist") {
      const cols = line.split(/\s+/);
      if (cols.length < 2) continue;
      const a = Number(cols[0]);
      note(a);
      for (let i = 1; i < cols.length; i++) {
        const b = Number(cols[i]);
        note(b);
        source.push(a - 1);
        target.push(b - 1);
        weight.push(1);
      }
      continue;
    }
  }

  const nodeCount = Math.max(declaredN, maxId);
  for (let i = 0; i < nodeCount; i++) if (labels[i] === undefined) labels[i] = String(i + 1);
  labels.length = nodeCount;

  let positions: Float32Array | undefined;
  if (coords.size > 0) {
    positions = new Float32Array(nodeCount * 2);
    for (const [idx, [x, y]] of coords) {
      positions[idx * 2] = x;
      positions[idx * 2 + 1] = y;
    }
  }

  return {
    nodeCount,
    source: Uint32Array.from(source),
    target: Uint32Array.from(target),
    weight: Float32Array.from(weight),
    labels,
    directed,
    positions,
  };
}
