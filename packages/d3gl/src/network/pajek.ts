/**
 * Pajek `.net` ingestion (sub-issue #102 / epic #98).
 *
 * Supports the common sections: `*Vertices` (with optional quoted labels and layout coordinates),
 * `*Arcs` / `*Arcslist` (directed) and `*Edges` / `*Edgeslist` (undirected). Vertex ids are read as
 * Infomap reads them (any non-negative integer, 0 and gaps included) and map to dense `0..n-1`
 * indices in ascending id order, so the result drops straight into {@link ./graph.js}'s `buildGraph`.
 * Unknown sections (e.g. `*Matrix`) are skipped.
 */
import { IdSlots, MAX_ID_TABLE, parseEdgeList, parseId, type ParsedEdges } from "./parse.js";

export interface ParsedPajek extends ParsedEdges {
  /** True when the file declared `*Arcs` / `*Arcslist` (directed edges). */
  directed: boolean;
  /** Interleaved `[x, y, …]` layout coordinates from `*Vertices`, present only if any were given. */
  positions?: Float32Array;
}

/** Network text formats {@link parseNetwork} can read. */
export type NetworkFormat = "pajek" | "edgelist";

/**
 * Pick a parser: Pajek for a `.net` filename or text with a `*Vertices`/`*Arcs`/`*Edges` section
 * header; otherwise the plain edge list. A filename extension wins over content sniffing.
 */
export function detectFormat(text: string, filename?: string): NetworkFormat {
  if (filename && /\.net$/i.test(filename)) return "pajek";
  if (filename && /\.(edges?|tsv|csv|txt)$/i.test(filename)) return "edgelist";
  return /^\s*\*(vertices|arcs|edges)\b/im.test(text) ? "pajek" : "edgelist";
}

type Section = "vertices" | "arcs" | "edges" | "arcslist" | "edgeslist" | "ignore";

const vertexId = (token: string | undefined): number => (token === undefined ? -1 : parseId(token));

const invalid = (lineIndex: number, line: string, expected: string): Error =>
  new Error(`parsePajek: line ${lineIndex + 1} ("${line}"): expected ${expected}`);

/**
 * Parse a Pajek `.net` document into a directed-or-undirected edge list (+ optional positions).
 *
 * Vertex ids are keys, as Infomap reads them: any non-negative integer up to 4294967295, 0 included,
 * with gaps. A node is a vertex line's id or an id a link uses (its label is then the id); the
 * `*Vertices` count adds no nodes. Dense indices follow ascending id, so a file numbered 1..N puts
 * vertex v at index v - 1, and `ids` gives each index's id. `%` and `#` lines are comments in every
 * section. A vertex or link line without valid ids throws, naming the line.
 */
export function parsePajek(text: string): ParsedPajek {
  const lines = text.split("\n");
  // Nodes get a slot as their id first appears; slots are reordered by id at the end.
  const slots = new IdSlots(Math.min(MAX_ID_TABLE, 2 * lines.length + 2));
  const slotLabels: (string | undefined)[] = [];
  const coords = new Map<number, [number, number]>();
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  let directed = false;
  let section: Section = "ignore";

  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] ?? "").trim();
    if (line === "" || line.startsWith("%") || line.startsWith("#")) continue;

    if (line.startsWith("*")) {
      const lower = line.toLowerCase();
      // Order matters: `*arcslist` / `*edgeslist` must be tested before `*arcs` / `*edges`.
      if (lower.startsWith("*vertices")) {
        section = "vertices";
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
      // The id is the whole first token: Infomap refuses `12abc` and `1"a"`.
      const m = /^(\S+)\s*(.*)$/.exec(line);
      const id = vertexId(m?.[1]);
      if (id < 0) throw invalid(n, line, "a vertex id (a non-negative integer up to 4294967295)");
      const s = slots.slot(id);
      const rest = m?.[2] ?? "";
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
        label = parts[0] ?? "";
        coordStr = parts.slice(1).join(" ");
      }
      slotLabels[s] = label;
      if (coordStr !== "") {
        const nums = coordStr.split(/\s+/).map(Number);
        const x = nums[0];
        const y = nums[1];
        if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
          coords.set(s, [x, y]);
        }
      }
      continue;
    }

    if (section === "arcs" || section === "edges") {
      const cols = line.split(/\s+/);
      const a = vertexId(cols[0]);
      const b = vertexId(cols[1]);
      if (a < 0 || b < 0) throw invalid(n, line, "two vertex ids and an optional weight");
      source.push(slots.slot(a));
      target.push(slots.slot(b));
      weight.push(cols.length > 2 ? Number(cols[2]) : 1);
      continue;
    }

    if (section === "arcslist" || section === "edgeslist") {
      const cols = line.split(/\s+/);
      if (cols.length < 2) continue;
      const a = vertexId(cols[0]);
      if (a < 0) throw invalid(n, line, "vertex ids");
      const sa = slots.slot(a);
      for (let i = 1; i < cols.length; i++) {
        const b = vertexId(cols[i]);
        if (b < 0) throw invalid(n, line, "vertex ids");
        source.push(sa);
        target.push(slots.slot(b));
        weight.push(1);
      }
      continue;
    }
  }

  const nodeCount = slots.ids.length;
  // Slot → dense index (ascending id); undefined when the slots already ascend.
  const rank = slots.ranks();
  const indexOf = (s: number): number => (rank ? (rank[s] ?? s) : s);

  const ids = new Uint32Array(nodeCount);
  const labels = new Array<string>(nodeCount);
  slots.ids.forEach((id, s) => {
    ids[indexOf(s)] = id;
    labels[indexOf(s)] = slotLabels[s] ?? String(id);
  });

  let positions: Float32Array | undefined;
  if (coords.size > 0) {
    positions = new Float32Array(nodeCount * 2);
    for (const [s, [x, y]] of coords) {
      const idx = indexOf(s);
      positions[idx * 2] = x;
      positions[idx * 2 + 1] = y;
    }
  }

  const sourceIndex = Uint32Array.from(source);
  const targetIndex = Uint32Array.from(target);
  if (rank) {
    for (let e = 0; e < sourceIndex.length; e++) {
      sourceIndex[e] = rank[sourceIndex[e] ?? 0] ?? 0;
      targetIndex[e] = rank[targetIndex[e] ?? 0] ?? 0;
    }
  }

  return {
    nodeCount,
    source: sourceIndex,
    target: targetIndex,
    weight: Float32Array.from(weight),
    labels,
    directed,
    positions,
    ids,
  };
}

/**
 * Parse a network from text, choosing the format via {@link detectFormat}: Pajek `.net` or a plain
 * edge list (`source target [weight]`, `#` comments). Edge lists are reported as undirected.
 */
export function parseNetwork(text: string, filename?: string): ParsedPajek {
  if (detectFormat(text, filename) === "pajek") return parsePajek(text);
  return { ...parseEdgeList(text), directed: false };
}
