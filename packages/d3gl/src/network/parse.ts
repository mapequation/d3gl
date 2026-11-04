/**
 * Edge-list ingestion (sub-issue #99 / epic #98).
 *
 * Reads node ids as Infomap does (non-negative integers) and maps them to dense `0..n-1` indices in
 * first-seen order, so downstream SoA/CSR buffers (see {@link ./graph.js}) stay compact.
 */

export interface ParsedEdges {
  nodeCount: number;
  /** Directed edge endpoints as dense node indices. */
  source: Uint32Array;
  target: Uint32Array;
  /** Per-edge weight; defaults to 1 when no third column is present. */
  weight: Float32Array;
  /** Dense index → node label: the id in decimal for an edge list, the vertex name for Pajek. */
  labels: string[];
  /** Dense index → node id: the integer Infomap keys the node by (#408). */
  ids: Uint32Array;
}

/**
 * Parse a whitespace-separated edge list: `source target [weight]` per line, with node ids read as
 * Infomap reads them. Blank lines and `#` comment lines are ignored.
 *
 * Lines are split on `"\n"` and columns on the characters `/\s/` matches. A node id is a decimal
 * integer up to 4294967295, with an optional `+` and leading zeros (`01` and `1` are one node, labelled
 * `"1"`); a line whose first two columns are not two node ids throws, naming the line and why. Nodes
 * are indexed in first-seen order, source before target; duplicate edges and self-loops are kept. The
 * weight is `Number(column 3)`, so it can be `NaN`. Columns past the third are ignored.
 *
 * O(characters): a newline count to size the columns, then one scan, with no per-line or per-column
 * strings. Ids are indexed by value in a typed array, sparse large ids in a Map ({@link IdSlots}).
 */
export function parseEdgeList(text: string): ParsedEdges {
  const n = text.length;
  // An edge takes a line of its own, so the line count bounds the edge count: size the columns once.
  let capacity = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) capacity++;
  let source = new Uint32Array(capacity);
  let target = new Uint32Array(capacity);
  let weight = new Float32Array(capacity);
  const slots = new IdSlots(Math.min(MAX_ID_TABLE, 2 * capacity + 2));
  let count = 0;

  for (let pos = 0, line = 0; pos < n; line++) {
    const bol = pos;
    let eol = text.indexOf("\n", pos);
    if (eol === -1) eol = n;
    let i = skipSpace(text, pos, eol);
    pos = eol + 1;
    if (i === eol || text.charCodeAt(i) === HASH) continue; // blank line or comment
    const s1 = i;
    i = columnEnd(text, i, eol);
    const e1 = i;
    i = skipSpace(text, i, eol);
    if (i === eol) throw lineError(text, line, bol, eol, "expected a source and a target node id");
    const s2 = i;
    i = columnEnd(text, i, eol);
    const e2 = i;
    i = skipSpace(text, i, eol);
    const a = parseId(text, s1, e1);
    const b = parseId(text, s2, e2);
    if (a < 0 || b < 0) {
      const token = a < 0 ? text.slice(s1, e1) : text.slice(s2, e2);
      throw lineError(text, line, bol, eol, `"${token}" is not a node id (a non-negative integer up to 4294967295)`);
    }
    source[count] = slots.slot(a);
    target[count] = slots.slot(b);
    weight[count] = i === eol ? 1 : parseWeight(text, i, columnEnd(text, i, eol));
    count++;
  }

  if (count < capacity) {
    // Comment/blank lines leave the columns over-allocated: hand back exact-length buffers.
    source = source.slice(0, count);
    target = target.slice(0, count);
    weight = weight.slice(0, count);
  }
  return {
    nodeCount: slots.ids.length,
    source,
    target,
    weight,
    labels: slots.ids.map(String),
    ids: Uint32Array.from(slots.ids),
  };
}

function lineError(text: string, line: number, bol: number, eol: number, why: string): Error {
  return new Error(`parseEdgeList: line ${line + 1} ("${text.slice(bol, eol).trim()}"): ${why}`);
}

const HASH = 35; // "#"
const ZERO = 48; // "0"
/** Largest by-value table (entries, 4 bytes each); sparser ids fall back to a number-keyed Map. */
export const MAX_ID_TABLE = 1 << 22;
/** The largest node id: Infomap reads ids as unsigned 32-bit integers. */
export const MAX_ID = 0xffffffff;
const PLUS = 43; // "+"

/**
 * `text[start, end)` as a node id, as Infomap reads one: decimal digits after an optional `+`, leading
 * zeros allowed (`01` is 1), at most {@link MAX_ID}; -1 for anything else.
 */
export function parseId(text: string, start = 0, end = text.length): number {
  if (start < end && text.charCodeAt(start) === PLUS) start++;
  if (start === end) return -1;
  let id = 0;
  for (let i = start; i < end; i++) {
    const digit = text.charCodeAt(i) - ZERO;
    if (digit < 0 || digit > 9) return -1;
    id = id * 10 + digit;
    if (id > MAX_ID) return -1;
  }
  return id;
}

/**
 * Node id → slot, in order of first appearance. Ids below `cap` are looked up in a typed array, the
 * rest in a Map; the cap comes from the line count, so the table's memory stays O(lines) whatever the
 * ids.
 */
export class IdSlots {
  readonly ids: number[] = [];
  /** Id → slot + 1 (0 = unseen), for ids below {@link cap}. */
  private table = new Int32Array(0);
  private sparse: Map<number, number> | null = null;

  constructor(private readonly cap: number) {}

  /** The id's slot, added if new. */
  slot(id: number): number {
    if (id < this.cap) {
      if (id >= this.table.length) this.grow(id);
      const seen = this.table[id] ?? 0;
      if (seen !== 0) return seen - 1;
      this.table[id] = this.ids.length + 1;
    } else {
      const sparse = this.sparse ?? (this.sparse = new Map());
      const seen = sparse.get(id);
      if (seen !== undefined) return seen;
      sparse.set(id, this.ids.length);
    }
    this.ids.push(id);
    return this.ids.length - 1;
  }

  /**
   * Each slot's dense index, by ascending id; undefined when the ids first appeared in ascending order
   * (each slot is then its index). Ids in the table are ranked by scanning it in id order, O(table),
   * with no sort; only the ids above the cap, which rank after all of the table's, are sorted.
   */
  ranks(): Uint32Array | undefined {
    const ids = this.ids;
    let ascending = true;
    for (let s = 1; s < ids.length && ascending; s++) ascending = (ids[s - 1] ?? 0) < (ids[s] ?? 0);
    if (ascending) return undefined;
    const rank = new Uint32Array(ids.length);
    let k = 0;
    for (let id = 0; id < this.table.length; id++) {
      const seen = this.table[id] ?? 0;
      if (seen !== 0) rank[seen - 1] = k++;
    }
    const sparse = this.sparse;
    if (sparse) {
      for (const id of Uint32Array.from(sparse.keys()).sort()) rank[sparse.get(id) ?? 0] = k++;
    }
    return rank;
  }

  private grow(id: number): void {
    const size = Math.min(this.cap, Math.max(id + 1, 2 * this.table.length, 1024));
    const grown = new Int32Array(size);
    grown.set(this.table);
    this.table = grown;
  }
}

/** `Number(text[start, end))`, without the slice when the column is plain digits (exact below 2^53). */
function parseWeight(text: string, start: number, end: number): number {
  if (end - start <= 15) {
    let value = 0;
    let i = start;
    for (; i < end; i++) {
      const digit = text.charCodeAt(i) - ZERO;
      if (digit < 0 || digit > 9) break;
      value = value * 10 + digit;
    }
    if (i === end) return value;
  }
  return Number(text.slice(start, end));
}

function skipSpace(text: string, i: number, end: number): number {
  while (i < end && isSpace(text.charCodeAt(i))) i++;
  return i;
}

function columnEnd(text: string, i: number, end: number): number {
  while (i < end && !isSpace(text.charCodeAt(i))) i++;
  return i;
}

/** Exactly the UTF-16 code units `/\s/` matches (ECMAScript WhiteSpace + LineTerminator). */
function isSpace(c: number): boolean {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 0xa0) return false;
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}
