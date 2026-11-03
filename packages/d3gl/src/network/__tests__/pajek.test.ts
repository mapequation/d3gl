import { describe, it, expect } from "vitest";
import { parsePajek, parseNetwork, detectFormat } from "../pajek.js";

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

    expect(p.nodeCount).toBe(3); // the ids the links use
    expect(p.labels).toEqual(["1", "2", "3"]);
    expect(Array.from(p.ids!)).toEqual([1, 2, 3]);
    expect(Array.from(p.source)).toEqual([0, 2]);
    expect(Array.from(p.target)).toEqual([2, 1]);
  });

  // Infomap 2.15.1 outputs nodes 0, 2, 5 and 7 (7 unnamed) for this file (#590).
  it("keys vertices by id as Infomap does: 0, gaps and link-only ids", () => {
    const p = parsePajek(
      ["*Vertices 3", '0 "zero"', '2 "two"', '5 "five"', "*Edges", "0 2", "2 5 2", "5 7"].join("\n"),
    );

    expect(p.nodeCount).toBe(4);
    expect(Array.from(p.ids!)).toEqual([0, 2, 5, 7]);
    expect(p.labels).toEqual(["zero", "two", "five", "7"]);
    expect(Array.from(p.source)).toEqual([0, 1, 2]);
    expect(Array.from(p.target)).toEqual([1, 2, 3]);
    expect(Array.from(p.weight)).toEqual([1, 2, 1]);
  });

  it("adds no nodes for the *Vertices count", () => {
    const p = parsePajek(["*Vertices 5", '1 "a"', '2 "b"', '3 "c"', "*Edges", "1 2", "2 3"].join("\n"));

    expect(p.nodeCount).toBe(3);
    expect(Array.from(p.ids!)).toEqual([1, 2, 3]);
  });

  it("orders nodes by id whatever the order of the vertex lines, with their coordinates", () => {
    const p = parsePajek(['*Vertices 3', '30 "c" 0.3 0.3', '10 "a" 0.1 0.1', '20 "b"', "*Arcs", "30 10"].join("\n"));

    expect(Array.from(p.ids!)).toEqual([10, 20, 30]);
    expect(p.labels).toEqual(["a", "b", "c"]);
    expect(Array.from(p.source)).toEqual([2]);
    expect(Array.from(p.target)).toEqual([0]);
    expect(Array.from(p.positions!)).toEqual([0.1, 0.1, 0, 0, 0.3, 0.3].map((v) => Math.fround(v)));
  });

  it("reads # lines as comments in every section (#589)", () => {
    const p = parsePajek(["# header", "*Vertices 2", "# names", '1 "a"', '2 "b"', "*Edges", "# links", "1 2"].join("\n"));

    expect(p.nodeCount).toBe(2);
    expect(Array.from(p.source)).toEqual([0]);
    expect(Array.from(p.target)).toEqual([1]);
  });

  it("throws on a line without valid vertex ids, naming it, as Infomap refuses it", () => {
    expect(() => parsePajek("*Edges\n1 2\na b")).toThrow('line 3 ("a b")');
    expect(() => parsePajek("*Edges\n-1 2")).toThrow("line 2");
    expect(() => parsePajek("*Edges\n1")).toThrow("line 2");
    expect(() => parsePajek('*Vertices 1\n5000000000 "big"')).toThrow("line 2");
    expect(() => parsePajek('*Vertices 1\n"no id"')).toThrow("line 2");
    expect(() => parsePajek("*Edgeslist\n1 2 x")).toThrow("line 2");
  });
});

describe("detectFormat / parseNetwork", () => {
  it("detects Pajek by .net filename or a *section header, else edge list", () => {
    expect(detectFormat("a b\nb c", "graph.net")).toBe("pajek"); // extension wins over content
    expect(detectFormat("*Vertices 2\n1 a\n2 b\n*Edges\n1 2")).toBe("pajek"); // content sniff
    expect(detectFormat("a b 2\nb c 1")).toBe("edgelist");
    expect(detectFormat("a b", "graph.txt")).toBe("edgelist");
  });

  it("parses an edge list (the non-Pajek path) as undirected dense indices", () => {
    const p = parseNetwork("# comment\nalice bob 2\nbob carol", "friends.txt");

    expect(p.directed).toBe(false);
    expect(p.labels).toEqual(["alice", "bob", "carol"]);
    expect(Array.from(p.source)).toEqual([0, 1]);
    expect(Array.from(p.target)).toEqual([1, 2]);
    expect(Array.from(p.weight)).toEqual([2, 1]);
    expect(p.positions).toBeUndefined();
  });

  it("routes a .net document through the Pajek parser", () => {
    const p = parseNetwork('*Vertices 2\n1 "x"\n2 "y"\n*Arcs\n1 2', "g.net");
    expect(p.directed).toBe(true);
    expect(p.labels).toEqual(["x", "y"]);
  });
});
