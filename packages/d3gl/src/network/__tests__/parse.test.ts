import { describe, it, expect } from "vitest";
import { parseEdgeList, type ParsedEdges } from "../parse.js";

/**
 * The line-splitting parser `parseEdgeList` shipped before the single-pass scanner. It is the
 * specification the fast path must reproduce exactly: `text.split("\n")`, `trim()`, `#` comments,
 * `split(/\s+/)`, lines with fewer than two columns skipped (without interning), labels interned in
 * first-seen order (source before target), duplicates and self-loops kept, `Number()` weights.
 */
function reference(text: string): ParsedEdges {
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
    source.push(intern(cols[0] ?? ""));
    target.push(intern(cols[1] ?? ""));
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

/** Field-by-field identity with the reference, including exact-length buffers and NaN weights. */
function expectSameAsReference(text: string): ParsedEdges {
  const got = parseEdgeList(text);
  const want = reference(text);
  const where = JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
  expect(got.nodeCount, where).toBe(want.nodeCount);
  expect(got.labels, where).toEqual(want.labels);
  expect(Array.from(got.source), where).toEqual(Array.from(want.source));
  expect(Array.from(got.target), where).toEqual(Array.from(want.target));
  expect(Array.from(got.weight), where).toEqual(Array.from(want.weight)); // toEqual treats NaN as equal to NaN
  expect(got.source.buffer.byteLength, where).toBe(want.source.byteLength);
  expect(got.target.buffer.byteLength, where).toBe(want.target.byteLength);
  expect(got.weight.buffer.byteLength, where).toBe(want.weight.byteLength);
  return got;
}

describe("parseEdgeList", () => {
  it("maps labels to dense first-seen indices and reads endpoints, defaulting weight to 1", () => {
    const p = parseEdgeList("a b\nb c");

    expect(p.labels).toEqual(["a", "b", "c"]);
    expect(p.nodeCount).toBe(3);
    expect(Array.from(p.source)).toEqual([0, 1]);
    expect(Array.from(p.target)).toEqual([1, 2]);
    expect(Array.from(p.weight)).toEqual([1, 1]);
  });

  it("reads an optional third weight column and reuses indices for repeated labels", () => {
    const p = parseEdgeList("a b 2.5\na c 1.5");

    expect(p.labels).toEqual(["a", "b", "c"]);
    expect(Array.from(p.source)).toEqual([0, 0]);
    expect(Array.from(p.target)).toEqual([1, 2]);
    expect(Array.from(p.weight)).toEqual([2.5, 1.5]);
  });

  it("skips blank lines and # comments", () => {
    const p = parseEdgeList("# header\n\na b\n   \n# mid\nb c\n");

    expect(p.nodeCount).toBe(3);
    expect(Array.from(p.source)).toEqual([0, 1]);
    expect(Array.from(p.target)).toEqual([1, 2]);
  });

  it("maps integer ids in first-seen order, not by value, keeping duplicates and self-loops", () => {
    const p = expectSameAsReference("# SNAP-style header\n5 3\n3 5\n5 3\n7 7\n0 5\n");

    expect(p.labels).toEqual(["5", "3", "7", "0"]);
    expect(Array.from(p.source)).toEqual([0, 1, 0, 2, 3]);
    expect(Array.from(p.target)).toEqual([1, 0, 1, 2, 0]);
  });
});

describe("parseEdgeList — identical to the line-splitting reference", () => {
  const cases: Record<string, string> = {
    "integer ids": "0 1\n0 2\n1 2\n2 0\n",
    "one-based integer ids": "1 2\n2 3\n3 1",
    "non-integer ids": "alice bob\nbob carol\ncarol alice\n",
    // Canonical integers and every look-alike that is a *different* label: leading zeros, signs,
    // decimals, exponents, hex. "1" and "01" must stay two nodes.
    "mixed integer and look-alike ids": "1 01\n01 1\n1 1.0\n-1 +1\n1e0 0x1\n0 00\n007 7\nnode7 7\n",
    "ids past the integer table": "0 4294967296\n4294967296 0\n9999999999 99999999999999999999\n123456789 1234567890\n",
    "sparse large integer ids": "1000000000 3\n3 999999999\n999999999 1000000000\n",
    "comments": "# a\n#b c\n  # indented\n\t# tabbed\na # b\n#\n# c d 3\nx y\n",
    "integer weights": "0 1 3\n1 2 10\n2 0 007\n0 0 0\n",
    "decimal and signed weights": "a b 2.5\nb c -1.25\nc a +3\na a .5\nb b 5.\n",
    "exponent, hex, special and invalid weights": "a b 1e3\nb c 0x1F\nc d Infinity\nd e -Infinity\ne f abc\nf g 1_000\ng h NaN\nh i 0b11\n",
    "float32 rounding of weights": "a b 0.1\nb c 16777217\nc d 1e40\nd e 3.4028235677973366e38\ne f 123456789012345678\n",
    "extra columns": "a b 2 9 9\nb c 3 x\n",
    "single-token lines are skipped without interning": "lonely\na b\nb\nc d\n",
    "tabs, runs of spaces and CRLF": "a\tb\r\nb  \t c\t4\r\n\r\n  c   d  \r\n",
    "exotic whitespace separates columns": "a b\nb c　2\nc\u000bd\u000c3\nd e\ne f 1\n﻿g h\n",
    "a lone carriage return does not end a line": "a b\rc d\ne f\r",
    "no trailing newline": "a b\nb c",
    "empty input": "",
    "only comments and blanks": "# x\n\n   \n\t\n",
    "unicode labels": "zürich genève\ngenève 東京 2\n😀 zürich\n",
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
      const edges = parseEdgeList(`a${ch}b`).source.length;
      expect(edges, `U+${c.toString(16).padStart(4, "0")}`).toBe(/\s/.test(ch) ? 1 : 0);
    }
  });

  it("matches the reference on randomized edge lists", () => {
    let s = 12345 >>> 0;
    const rnd = (n: number) => ((s = (s * 1664525 + 1013904223) >>> 0) % n);
    const tokens = ["0", "1", "2", "10", "01", "00", "a", "b", "#", "#x", "1.5", "-3", "+4", "1e2", "0x10", "999999999", "1000000000", "18446744073709551616", "é", "NaN"];
    const seps = [" ", "  ", "\t", " ", "\r", " \t "];
    const eols = ["\n", "\r\n", "\n\n", "\n# comment\n", "\n   \n"];
    for (let trial = 0; trial < 400; trial++) {
      let text = "";
      const lines = rnd(12);
      for (let l = 0; l < lines; l++) {
        if (rnd(4) === 0) text += seps[rnd(seps.length)];
        const cols = rnd(5);
        for (let c = 0; c < cols; c++) {
          if (c > 0) text += seps[rnd(seps.length)];
          text += tokens[rnd(tokens.length)];
        }
        if (rnd(4) === 0) text += seps[rnd(seps.length)];
        text += eols[rnd(eols.length)];
      }
      expectSameAsReference(text);
    }
  });

  it("matches the reference on a dense SNAP-style integer edge list", () => {
    let s = 7 >>> 0;
    const rnd = (n: number) => ((s = (s * 1664525 + 1013904223) >>> 0) % n);
    const n = 20_000;
    const rows = ["# Directed graph: synthetic", "# FromNodeId\tToNodeId"];
    for (let e = 0; e < 60_000; e++) rows.push(`${rnd(n)}\t${rnd(n)}`);
    const p = expectSameAsReference(`${rows.join("\n")}\n`);
    expect(p.source.length).toBe(60_000);
  });
});
