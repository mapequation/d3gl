import { describe, it, expect } from "vitest";
import { parseEdgeList, type ParsedEdges } from "../parse.js";

/** A token as a node id, as Infomap reads one: digits after an optional `+`, at most 4294967295. */
const referenceId = (token: string): number =>
  /^\+?\d+$/.test(token) && Number(token) <= 4294967295 ? Number(token) : -1;

/**
 * A line-splitting edge-list parser: the specification the fast path must reproduce exactly.
 * `text.split("\n")`, `trim()`, `#` comments, `split(/\s+/)`; the first two columns are node ids,
 * keyed by integer value and indexed in first-seen order (source before target); duplicates and
 * self-loops kept, `Number()` weights. A line without two node ids throws `line N`.
 */
function reference(text: string): ParsedEdges {
  const index = new Map<number, number>();
  const ids: number[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  const intern = (id: number): number => {
    let i = index.get(id);
    if (i === undefined) {
      i = ids.length;
      index.set(id, i);
      ids.push(id);
    }
    return i;
  };
  text.split("\n").forEach((raw, n) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const cols = line.split(/\s+/);
    const a = referenceId(cols[0] ?? "");
    const b = cols.length < 2 ? -1 : referenceId(cols[1] ?? "");
    if (a < 0 || b < 0) throw new Error(`line ${n + 1}`);
    source.push(intern(a));
    target.push(intern(b));
    weight.push(cols.length > 2 ? Number(cols[2]) : 1);
  });
  return {
    nodeCount: ids.length,
    source: Uint32Array.from(source),
    target: Uint32Array.from(target),
    weight: Float32Array.from(weight),
    labels: ids.map(String),
    ids: Uint32Array.from(ids),
  };
}

/**
 * Field-by-field identity with the reference, including exact-length buffers and NaN weights; or,
 * when the reference throws, the fast path throws naming the same line. Returns the parse, if any.
 */
function expectSameAsReference(text: string): ParsedEdges | null {
  const where = JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
  let want: ParsedEdges;
  try {
    want = reference(text);
  } catch (err) {
    const line = err instanceof Error ? err.message : String(err);
    expect(() => parseEdgeList(text), where).toThrow(`${line} (`);
    return null;
  }
  const got = parseEdgeList(text);
  expect(got.nodeCount, where).toBe(want.nodeCount);
  expect(got.labels, where).toEqual(want.labels);
  expect(Array.from(got.ids), where).toEqual(Array.from(want.ids));
  expect(Array.from(got.source), where).toEqual(Array.from(want.source));
  expect(Array.from(got.target), where).toEqual(Array.from(want.target));
  expect(Array.from(got.weight), where).toEqual(Array.from(want.weight)); // toEqual treats NaN as equal to NaN
  expect(got.source.buffer.byteLength, where).toBe(want.source.byteLength);
  expect(got.target.buffer.byteLength, where).toBe(want.target.byteLength);
  expect(got.weight.buffer.byteLength, where).toBe(want.weight.byteLength);
  return got;
}

describe("parseEdgeList", () => {
  it("maps node ids to dense first-seen indices and reads endpoints, defaulting weight to 1", () => {
    const p = parseEdgeList("10 20\n20 30");

    expect(p.labels).toEqual(["10", "20", "30"]);
    expect(Array.from(p.ids)).toEqual([10, 20, 30]);
    expect(p.nodeCount).toBe(3);
    expect(Array.from(p.source)).toEqual([0, 1]);
    expect(Array.from(p.target)).toEqual([1, 2]);
    expect(Array.from(p.weight)).toEqual([1, 1]);
  });

  it("reads an optional third weight column and reuses indices for repeated ids", () => {
    const p = parseEdgeList("1 2 2.5\n1 3 1.5");

    expect(Array.from(p.ids)).toEqual([1, 2, 3]);
    expect(Array.from(p.source)).toEqual([0, 0]);
    expect(Array.from(p.target)).toEqual([1, 2]);
    expect(Array.from(p.weight)).toEqual([2.5, 1.5]);
  });

  it("skips blank lines and # comments", () => {
    const p = parseEdgeList("# header\n\n1 2\n   \n# mid\n2 3\n");

    expect(p.nodeCount).toBe(3);
    expect(Array.from(p.source)).toEqual([0, 1]);
    expect(Array.from(p.target)).toEqual([1, 2]);
  });

  it("indexes ids in first-seen order, not by value, keeping duplicates and self-loops", () => {
    const p = expectSameAsReference("# SNAP-style header\n5 3\n3 5\n5 3\n7 7\n0 5\n");

    expect(p?.labels).toEqual(["5", "3", "7", "0"]);
    expect(Array.from(p?.ids ?? [])).toEqual([5, 3, 7, 0]);
    expect(Array.from(p?.source ?? [])).toEqual([0, 1, 0, 2, 3]);
    expect(Array.from(p?.target ?? [])).toEqual([1, 0, 1, 2, 0]);
  });

  // Infomap 2.15.1 reads this file as nodes 0, 1, 2, 3 and 5 with links 1→2, 1→3 (2) and 5→0 (#408).
  it("reads ids by value as Infomap does: 01 is 1, +3 is 3", () => {
    const p = parseEdgeList("01 2\n1 +3 2\n5 0\n");

    expect(Array.from(p.ids)).toEqual([1, 2, 3, 5, 0]);
    expect(p.labels).toEqual(["1", "2", "3", "5", "0"]);
    expect(Array.from(p.source)).toEqual([0, 0, 3]);
    expect(Array.from(p.target)).toEqual([1, 2, 4]);
    expect(Array.from(p.weight)).toEqual([1, 2, 1]);
  });

  it("throws on a line without two node ids, naming the line and why, as Infomap refuses it", () => {
    expect(() => parseEdgeList("1 2\na b")).toThrow(
      'parseEdgeList: line 2 ("a b"): "a" is not a node id (a non-negative integer up to 4294967295)',
    );
    expect(() => parseEdgeList("1 2\n\n3")).toThrow('line 3 ("3"): expected a source and a target node id');
    expect(() => parseEdgeList("1 4294967296")).toThrow('line 1 ("1 4294967296"): "4294967296" is not a node id');
    expect(() => parseEdgeList("-1 2")).toThrow('"-1" is not a node id');
    expect(() => parseEdgeList("1 2.0")).toThrow('"2.0" is not a node id');
    expect(() => parseEdgeList("1 # 2")).toThrow('"#" is not a node id'); // # starts a comment only at the line start
  });

  it("accepts the largest id, 4294967295", () => {
    const p = parseEdgeList("4294967295 0");

    expect(Array.from(p.ids)).toEqual([4294967295, 0]);
  });
});

describe("parseEdgeList — identical to the line-splitting reference", () => {
  const cases: Record<string, string> = {
    "integer ids": "0 1\n0 2\n1 2\n2 0\n",
    "one-based integer ids": "1 2\n2 3\n3 1",
    "names are not ids": "alice bob\nbob carol\ncarol alice\n",
    "leading zeros and + are the same id": "1 01\n01 1\n007 7\n+7 0\n0 00\n",
    "decimals, signs, exponents and hex are not ids": "1 01\n1 1.0\n-1 +1\n1e0 0x1\n",
    "ids past the integer table": "0 4294967295\n4294967295 0\n123456789 1234567890\n",
    "ids past 32 bits": "0 4294967296\n",
    "sparse large integer ids": "1000000000 3\n3 999999999\n999999999 1000000000\n",
    "comments": "# a\n#b c\n  # indented\n\t# tabbed\n1 2\n#\n# c d 3\n3 4\n",
    "# inside a line is not a comment": "1 2\n1 # 2\n",
    "integer weights": "0 1 3\n1 2 10\n2 0 007\n0 0 0\n",
    "decimal and signed weights": "1 2 2.5\n2 3 -1.25\n3 1 +3\n1 1 .5\n2 2 5.\n",
    "exponent, hex, special and invalid weights":
      "1 2 1e3\n2 3 0x1F\n3 4 Infinity\n4 5 -Infinity\n5 6 abc\n6 7 1_000\n7 8 NaN\n8 9 0b11\n",
    "float32 rounding of weights": "1 2 0.1\n2 3 16777217\n3 4 1e40\n4 5 3.4028235677973366e38\n5 6 123456789012345678\n",
    "extra columns": "1 2 2 9 9\n2 3 3 x\n",
    "a single-token line throws": "1 2\n3\n4 5\n",
    "tabs, runs of spaces and CRLF": "1\t2\r\n2  \t 3\t4\r\n\r\n  3   4  \r\n",
    "exotic whitespace separates columns": "1 2\n2 3　2\n3\u000b4\u000c3\n4 5\n5 6 1\n﻿7 8\n",
    "a lone carriage return does not end a line": "1 2\r3 4\n5 6\r",
    "no trailing newline": "1 2\n2 3",
    "empty input": "",
    "only comments and blanks": "# x\n\n   \n\t\n",
    "unicode tokens are not ids": "zürich genève\n",
  };

  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      expectSameAsReference(text);
    });
  }

  it("treats exactly the characters /\\s/ matches as column separators", () => {
    for (let c = 0; c <= 0xffff; c++) {
      if (c === 10) continue; // "\n" ends the line itself
      const ch = String.fromCharCode(c);
      const text = `1${ch}2`;
      if (/\s/.test(ch)) expect(parseEdgeList(text).source.length, `U+${c.toString(16)}`).toBe(1);
      else expect(() => parseEdgeList(text), `U+${c.toString(16)}`).toThrow("line 1");
    }
  });

  it("matches the reference on randomized edge lists", () => {
    let s = 12345 >>> 0;
    const rnd = (n: number) => ((s = (s * 1664525 + 1013904223) >>> 0) % n);
    const tokens = [
      ...["0", "1", "2", "10", "01", "00", "+4", "007", "999999999", "1000000000", "4294967295"],
      ...["0", "1", "2", "3", "5", "8", "13"],
      ...["a", "#", "#x", "1.5", "-3", "1e2", "0x10", "4294967296", "é", "NaN"],
    ];
    const seps = [" ", "  ", "\t", " ", "\r", " \t "];
    const eols = ["\n", "\r\n", "\n\n", "\n# comment\n", "\n   \n"];
    let parsed = 0;
    for (let trial = 0; trial < 600; trial++) {
      let text = "";
      const lines = rnd(8);
      for (let l = 0; l < lines; l++) {
        if (rnd(4) === 0) text += seps[rnd(seps.length)];
        const cols = 2 + rnd(3) - (rnd(10) === 0 ? 1 : 0);
        for (let c = 0; c < cols; c++) {
          if (c > 0) text += seps[rnd(seps.length)];
          text += tokens[rnd(tokens.length)];
        }
        if (rnd(4) === 0) text += seps[rnd(seps.length)];
        text += eols[rnd(eols.length)];
      }
      if (expectSameAsReference(text)) parsed++;
    }
    expect(parsed).toBeGreaterThan(50); // both outcomes are exercised
  });

  it("matches the reference on a dense SNAP-style integer edge list", () => {
    let s = 7 >>> 0;
    const rnd = (n: number) => ((s = (s * 1664525 + 1013904223) >>> 0) % n);
    const n = 20_000;
    const rows = ["# Directed graph: synthetic", "# FromNodeId\tToNodeId"];
    for (let e = 0; e < 60_000; e++) rows.push(`${rnd(n)}\t${rnd(n)}`);
    const p = expectSameAsReference(`${rows.join("\n")}\n`);
    expect(p?.source.length).toBe(60_000);
  });
});
