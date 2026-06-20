import { describe, it, expect } from "vitest";
import { parseEdgeList } from "../parse.js";

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
});
