import { describe, it, expect } from "vitest";
import { parsePajek } from "../pajek.js";

describe("parsePajek", () => {
  it("reads *Vertices labels + coordinates and *Arcs as a directed, 0-based edge list", () => {
    const p = parsePajek(
      ['*Vertices 3', '1 "Alpha" 0.1 0.2', '2 "Beta" 0.5 0.5', '3 "Gamma" 0.9 0.1', "*Arcs", "1 2 2.0", "2 3"].join(
        "\n",
      ),
    );

    expect(p.nodeCount).toBe(3);
    expect(p.labels).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(p.directed).toBe(true);
    expect(Array.from(p.source)).toEqual([0, 1]); // ids are 1-based in Pajek, dense 0-based here
    expect(Array.from(p.target)).toEqual([1, 2]);
    expect(Array.from(p.weight)).toEqual([2.0, 1]); // missing 3rd column defaults to 1
    expect(p.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(p.positions!)).toEqual([
      0.1, 0.2, 0.5, 0.5, 0.9, 0.1,
    ].map((v) => Math.fround(v)));
  });

  it("reads *Edges as undirected (directed = false) and a third weight column", () => {
    const p = parsePajek(['*Vertices 2', '1 "a"', '2 "b"', "*Edges", "1 2 3.5"].join("\n"));

    expect(p.directed).toBe(false);
    expect(Array.from(p.source)).toEqual([0]);
    expect(Array.from(p.target)).toEqual([1]);
    expect(Array.from(p.weight)).toEqual([3.5]);
    expect(p.positions).toBeUndefined(); // no coordinates present
  });

  it("ignores % comments and blank lines and treats section headers case-insensitively", () => {
    const p = parsePajek(["% a comment", "*vertices 2", '1 "x"', "", '2 "y"', "% mid", "*ARCS", "1 2"].join("\n"));

    expect(p.nodeCount).toBe(2);
    expect(p.labels).toEqual(["x", "y"]);
    expect(p.directed).toBe(true);
    expect(Array.from(p.source)).toEqual([0]);
  });

  it("expands *Edgeslist adjacency rows into pairwise undirected edges", () => {
    const p = parsePajek(['*Vertices 3', '1 "a"', '2 "b"', '3 "c"', "*Edgeslist", "1 2 3"].join("\n"));

    expect(p.directed).toBe(false);
    expect(Array.from(p.source)).toEqual([0, 0]);
    expect(Array.from(p.target)).toEqual([1, 2]);
  });

  it("defaults a vertex with no label to its id and infers nodeCount when *Vertices is absent", () => {
    const p = parsePajek(["*Arcs", "1 3", "3 2"].join("\n"));

    expect(p.nodeCount).toBe(3); // inferred from the largest endpoint id
    expect(p.labels).toEqual(["1", "2", "3"]);
    expect(Array.from(p.source)).toEqual([0, 2]);
    expect(Array.from(p.target)).toEqual([2, 1]);
  });
});
