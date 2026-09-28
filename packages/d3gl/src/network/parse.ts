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
 *
 * Lines are split on `"\n"` and columns on the characters `/\s/` matches; a line with a single
 * column is skipped. Labels are exact strings (`"1"` and `"01"` are two nodes), indexed in
 * first-seen order, source before target; duplicate edges and self-loops are kept. The weight is
 * `Number(column 3)`, so it can be `NaN`. Columns past the third are ignored.
 *
 * O(characters) — a newline count to size the columns, then one scan — with no per-line or
 * per-column strings: a label string is sliced once, when its node is first seen. Integer ids (the
 * common SNAP / Infomap case) are indexed by value in a typed array rather than hashed as strings.
 */
export function parseEdgeList(text: string): ParsedEdges {
  const n = text.length;
  // An edge takes a line of its own, so the line count bounds the edge count: size the columns once.
  let capacity = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) capacity++;
  let source = new Uint32Array(capacity);
  let target = new Uint32Array(capacity);
  let weight = new Float32Array(capacity);
  const index = new LabelIndex(text, capacity);
  let count = 0;

  for (let pos = 0; pos < n; ) {
    let eol = text.indexOf("\n", pos);
    if (eol === -1) eol = n;
    let i = skipSpace(text, pos, eol);
    pos = eol + 1;
    if (i === eol || text.charCodeAt(i) === HASH) continue; // blank line or comment
    const s1 = i;
    i = columnEnd(text, i, eol);
    const e1 = i;
    i = skipSpace(text, i, eol);
    if (i === eol) continue; // a single column is not an edge (and its label is not a node)
    const s2 = i;
    i = columnEnd(text, i, eol);
    const e2 = i;
    i = skipSpace(text, i, eol);
    source[count] = index.intern(s1, e1);
    target[count] = index.intern(s2, e2);
    weight[count] = i === eol ? 1 : parseWeight(text, i, columnEnd(text, i, eol));
    count++;
  }

  if (count < capacity) {
    // Comment/blank lines leave the columns over-allocated: hand back exact-length buffers.
    source = source.slice(0, count);
    target = target.slice(0, count);
    weight = weight.slice(0, count);
  }
  return { nodeCount: index.labels.length, source, target, weight, labels: index.labels };
}

const HASH = 35; // "#"
const ZERO = 48; // "0"
/** Longest canonical integer id indexed by value: 9 digits stay exact in an int32. */
const MAX_ID_DIGITS = 9;
/** Largest by-value table (entries, 4 bytes each); sparser ids fall back to a number-keyed Map. */
const MAX_ID_TABLE = 1 << 22;

/**
 * Label → dense index, in first-seen order. A label that is a canonical decimal integer (`0`, or
 * digits without a leading zero, at most {@link MAX_ID_DIGITS}) is keyed by its value; every other
 * label by its string. The two key spaces cannot collide — a canonical integer's string is never a
 * non-canonical label — so the split is invisible in the result.
 */
class LabelIndex {
  readonly labels: string[] = [];
  private readonly text: string;
  private readonly byName = new Map<string, number>();
  /** Canonical integer id → index + 1 (0 = unseen), for ids below {@link tableCap}. */
  private byValue = new Int32Array(0);
  /** Distinct ids never exceed twice the edge lines, so a dense id space fits in O(lines) memory. */
  private readonly tableCap: number;
  private bySparseValue: Map<number, number> | null = null;

  constructor(text: string, lines: number) {
    this.text = text;
    this.tableCap = Math.min(MAX_ID_TABLE, 2 * lines + 2);
  }

  intern(start: number, end: number): number {
    const value = canonicalInt(this.text, start, end);
    if (value < 0) return this.internName(start, end);
    if (value < this.tableCap) {
      if (value >= this.byValue.length) this.growTable(value);
      const seen = this.byValue[value] ?? 0;
      if (seen !== 0) return seen - 1;
      const id = this.add(start, end);
      this.byValue[value] = id + 1;
      return id;
    }
    const sparse = this.bySparseValue ?? (this.bySparseValue = new Map());
    const seen = sparse.get(value);
    if (seen !== undefined) return seen;
    const id = this.add(start, end);
    sparse.set(value, id);
    return id;
  }

  private internName(start: number, end: number): number {
    const label = this.text.slice(start, end);
    const seen = this.byName.get(label);
    if (seen !== undefined) return seen;
    const id = this.labels.length;
    this.labels.push(label);
    this.byName.set(label, id);
    return id;
  }

  private add(start: number, end: number): number {
    const id = this.labels.length;
    this.labels.push(this.text.slice(start, end));
    return id;
  }

  private growTable(value: number): void {
    const size = Math.min(this.tableCap, Math.max(value + 1, 2 * this.byValue.length, 1024));
    const grown = new Int32Array(size);
    grown.set(this.byValue);
    this.byValue = grown;
  }
}

/** The value of `text[start, end)` when it is a canonical decimal integer id, else -1. */
function canonicalInt(text: string, start: number, end: number): number {
  const length = end - start;
  if (length > MAX_ID_DIGITS) return -1;
  const first = text.charCodeAt(start) - ZERO;
  if (first < 0 || first > 9 || (first === 0 && length > 1)) return -1;
  let value = first;
  for (let i = start + 1; i < end; i++) {
    const digit = text.charCodeAt(i) - ZERO;
    if (digit < 0 || digit > 9) return -1;
    value = value * 10 + digit;
  }
  return value;
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
