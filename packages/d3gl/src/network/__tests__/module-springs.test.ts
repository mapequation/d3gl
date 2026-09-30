import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleLink } from "../modules.js";
import { DEFAULT_FORCE, DRAG_HEAT, ForceLayout, seedPositions, springStabilizers } from "../force.js";
import { multilevelLayout } from "../coarsen.js";
import { ModuleSpringForce, moduleSpringGain, moduleSpringsOf, moduleSpringScale, type ModuleSprings } from "../module-springs.js";
import { withModuleSprings } from "../worker-transport.js";
import { moduleSpringPlan } from "../gpu/module-springs.js";
import { LEAVES, LINKS, TOPS, centroid, fixture, springsOf } from "./module-springs-fixture.js";

/**
 * Module links as springs in the flat force layouts (#455): the springs read off a module tree, the CPU force
 * against a brute-force sum, the stabilizer, the GPU plan, and the behaviour — a module drag pulls a linked
 * module and not an unlinked one. Fixture: {@link ./module-springs-fixture.ts}.
 */
describe("moduleSpringsOf (#455)", () => {
  it("makes one spring per module link, in leaf-spring units, and leaves a link into its own ancestor out", () => {
    const f = fixture();
    const tree = buildModuleLODTree(f.graph.nodeCount, f.records, f.graph, [...LINKS, { source: [1], target: [1, 1], flow: 0.2 }]);
    const springs = moduleSpringsOf(tree, f.graph);
    if (!springs || !tree.parent) throw new Error("expected module springs");
    // Every leaf edge has weight 0.01, so one leaf spring is 0.01 of flow: a link of flow 0.3 is 30 springs.
    expect(moduleSpringScale(f.graph, [])).toBeCloseTo(100, 4);
    expect(springs.source.length).toBe(LINKS.length); // [1] → [1, 1] runs into its own ancestor: no spring
    const weights = Array.from(springs.weight).sort((a, b) => a - b);
    expect(weights.map((w) => Math.round(w * 1e4) / 1e4)).toEqual([5, 5, 5, 30, 30]);
    // The endpoints are the modules the links name.
    const topOf = (leaf: number): number => tree.parent![tree.parent![leaf]!]!;
    const m1 = topOf(f.top(1)[0]!);
    const m2 = topOf(f.top(2)[0]!);
    const pairs = Array.from(springs.source, (s, e) => `${s}-${springs.target[e]}`);
    expect(pairs).toContain(`${m1}-${m2}`);
    expect(pairs).toContain(`${m2}-${m1}`);
  });

  it("keeps a leaf endpoint as itself", () => {
    const f = fixture();
    const leaf = f.top(3)[0]!; // path [3, 1, 1]
    const springs = springsOf(f, [{ source: [3, 1, 1], target: [3, 2], flow: 0.1 }]);
    expect(springs.source.length).toBe(1);
    expect(springs.source[0]).toBe(leaf);
    expect(springs.target[0]).toBeGreaterThanOrEqual(f.graph.nodeCount);
  });

  it("is null for a module tree without module links", () => {
    const f = fixture();
    expect(moduleSpringsOf(buildModuleLODTree(f.graph.nodeCount, f.records, f.graph), f.graph)).toBeNull();
  });

  it("falls back to the module links' own mean flow when the graph's edges carry no weight", () => {
    expect(moduleSpringScale({ source: [], target: [], weight: [] }, [0.1, 0.3])).toBeCloseTo(5, 6);
    expect(moduleSpringScale({ source: [0], target: [1], weight: [0] }, [])).toBe(1);
  });
});

describe("ModuleSpringForce (#455)", () => {
  /** Brute force: every endpoint's leaves by walking up from each leaf, the springs, each member's share. */
  function reference(springs: ModuleSprings, positions: Float32Array, attraction: number, mass?: Float32Array): Float64Array {
    const n = springs.leafCount;
    const under = (g: number, i: number): boolean => {
      for (let x = i; x >= 0; x = springs.parent[x]!) if (x === g) return true;
      return false;
    };
    const members = (g: number): number[] => Array.from({ length: n }, (_, i) => i).filter((i) => under(g, i));
    const out = new Float64Array(n * 2);
    for (let e = 0; e < springs.source.length; e++) {
      const a = members(springs.source[e]!);
      const b = members(springs.target[e]!);
      const centre = (ids: number[]): [number, number, number] => {
        let x = 0, y = 0, m = 0;
        for (const i of ids) {
          const w = mass ? mass[i]! : 1;
          x += w * positions[i * 2]!;
          y += w * positions[i * 2 + 1]!;
          m += w;
        }
        return [x / m, y / m, m];
      };
      const [xa, ya, ma] = centre(a);
      const [xb, yb, mb] = centre(b);
      const k = attraction * springs.weight[e]!;
      for (const i of a) {
        out[i * 2] = out[i * 2]! + (k * (xb - xa)) / ma;
        out[i * 2 + 1] = out[i * 2 + 1]! + (k * (yb - ya)) / ma;
      }
      for (const i of b) {
        out[i * 2] = out[i * 2]! - (k * (xb - xa)) / mb;
        out[i * 2 + 1] = out[i * 2 + 1]! - (k * (yb - ya)) / mb;
      }
    }
    return out;
  }

  for (const withMass of [false, true]) {
    it(`matches a brute-force sum over every endpoint's members${withMass ? " (with masses)" : ""}`, () => {
      const f = fixture();
      const springs = springsOf(f, [...LINKS, { source: [3, 1, 2], target: [1, 2], flow: 0.02 }]);
      const n = f.graph.nodeCount;
      let s = 3;
      const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const positions = Float32Array.from({ length: n * 2 }, () => rng() * 400 - 200);
      const mass = withMass ? Float32Array.from({ length: n }, () => 1 + Math.floor(rng() * 4)) : undefined;
      const fx = new Float32Array(n);
      const fy = new Float32Array(n);
      new ModuleSpringForce(springs, mass).apply(positions, 0.05, fx, fy);
      const want = reference(springs, positions, 0.05, mass);
      for (let i = 0; i < n; i++) {
        expect(fx[i]).toBeCloseTo(want[i * 2]!, 3);
        expect(fy[i]).toBeCloseTo(want[i * 2 + 1]!, 3);
      }
    });
  }

  it("moves a module as one body: every member of an endpoint gets the same acceleration", () => {
    const f = fixture();
    const springs = springsOf(f, [{ source: [1], target: [3], flow: 0.3 }]);
    const n = f.graph.nodeCount;
    seedPositions(f.graph, 800, 600);
    const fx = new Float32Array(n);
    const fy = new Float32Array(n);
    new ModuleSpringForce(springs).apply(f.graph.positions, 0.05, fx, fy);
    for (const [t, sign] of [[1, 1], [3, -1]] as const) {
      const ids = f.top(t);
      for (const i of ids) {
        expect(fx[i]).toBeCloseTo(fx[ids[0]!]!, 5);
        expect(fy[i]).toBeCloseTo(fy[ids[0]!]!, 5);
      }
      // Toward the other end.
      const [xa] = centroid(f.graph.positions, f.top(1));
      const [xb] = centroid(f.graph.positions, f.top(3));
      expect(Math.sign(fx[ids[0]!]!)).toBe(sign * Math.sign(xb - xa));
    }
    for (const i of f.top(2)) {
      expect(fx[i]).toBe(0);
      expect(fy[i]).toBe(0);
    }
  });
});

describe("springStabilizers with module springs (#455, #203)", () => {
  it("counts a module's spring gain on its members, and is unchanged without module springs", () => {
    const f = fixture();
    const springs = springsOf(f, LINKS);
    const { source, target, edgeCount, nodeCount } = f.graph;
    const params = DEFAULT_FORCE;
    const plain = springStabilizers(nodeCount, source, target, edgeCount, params);
    const again = springStabilizers(nodeCount, source, target, edgeCount, params, undefined, undefined, undefined);
    expect(Array.from(again)).toEqual(Array.from(plain));
    const gain = moduleSpringGain(springs);
    const stab = springStabilizers(nodeCount, source, target, edgeCount, params, undefined, undefined, springs);
    const k = 0.9 * params.alpha * params.attraction;
    const linked = new Set([...f.top(1), ...f.top(2), ...f.top(3)]);
    for (let i = 0; i < nodeCount; i++) {
      if (linked.has(i)) expect(gain[i]).toBeGreaterThan(0);
      else expect(gain[i]).toBe(0); // in no linked module: its stabilizer is the plain one
      expect(stab[i]).toBeCloseTo(1 / (1 / plain[i]! + k * gain[i]!), 6);
    }
    // Module 1's leaves: the top link (30 + 30 springs over 12 leaves) and their half's own link (5 over 6).
    expect(gain[f.top(1)[0]!]).toBeCloseTo(60 / (2 * LEAVES) + 5 / LEAVES, 4);
  });
});

describe("a module drag pulls the modules linked to it (#455)", () => {
  /**
   * The force backend's drag, as `beginNodeDrag` runs it: lay out, then move module 1's held leaves `shift`
   * away over `FRAMES` frames (along the line from the layout's centroid to module 1's), ticking once per
   * frame at the drag heat. Returns how far module 2 moved along that line, and the other modules on
   * average, in equilibrium spacings, as the drag lands. (Centering pulls every free node toward the centroid
   * the held module shifts, so the whole layout creeps after it; the module link is what moves module 2 more.)
   */
  const FRAMES = 30;
  function drag(links: ModuleLink[] | null): { followed2: number; others: number } {
    const f = fixture();
    const springs = links ? springsOf(f, links) : undefined;
    const graph = withModuleSprings(f.graph, springs);
    multilevelLayout(graph, { width: 800, height: 600, iterations: 300 });
    const p = graph.positions;
    const m1 = f.top(1);
    const [x1, y1] = centroid(p, m1);
    const [x0, y0] = centroid(p, Array.from({ length: f.graph.nodeCount }, (_, i) => i));
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const spacing = Math.sqrt((Math.PI * DEFAULT_FORCE.repulsion) / DEFAULT_FORCE.centering);
    const shift = 12 * spacing;
    const before = Array.from({ length: TOPS }, (_, t) => centroid(p, f.top(t + 1)));
    const sim = new ForceLayout(graph);
    sim.setPinned(m1);
    sim.hold(DRAG_HEAT);
    const start = m1.map((i) => [p[i * 2]!, p[i * 2 + 1]!] as const);
    for (let frame = 1; frame <= FRAMES; frame++) {
      const t = frame / FRAMES;
      m1.forEach((i, k) => {
        p[i * 2] = start[k]![0] + t * shift * ux;
        p[i * 2 + 1] = start[k]![1] + t * shift * uy;
      });
      sim.tick();
    }
    const along = (t: number): number => {
      const [x, y] = centroid(p, f.top(t));
      const [bx, by] = before[t - 1]!;
      return ((x - bx) * ux + (y - by) * uy) / spacing;
    };
    let others = 0;
    for (let t = 3; t <= TOPS; t++) others += along(t) / (TOPS - 2);
    return { followed2: along(2), others };
  }

  it("a linked module follows the dragged one; an unlinked one does not", () => {
    // Measured: module 2 followed 6.6 of the 12 spacings, the others 1.0 on average.
    const { followed2, others } = drag(LINKS);
    expect(followed2 - others).toBeGreaterThan(4);
  });

  it("without module links module 2 moves like any other module (the leaf graph has no edge between them)", () => {
    // Measured: 0.71 against 0.76.
    const { followed2, others } = drag(null);
    expect(Math.abs(followed2 - others)).toBeLessThan(1);
  });

  it("changes nothing without module links: the solver sees the graph itself", () => {
    const f = fixture();
    expect(withModuleSprings(f.graph, undefined)).toBe(f.graph);
  });
});

describe("moduleSpringPlan (#455, the GPU layout)", () => {
  it("orders the leaves so every endpoint is one contiguous range, and chains each leaf's endpoints", () => {
    const f = fixture();
    const links: ModuleLink[] = [...LINKS, { source: [3, 1, 2], target: [1, 2], flow: 0.02 }];
    const springs = springsOf(f, links);
    const plan = moduleSpringPlan(springs);
    const n = f.graph.nodeCount;
    expect(Array.from(plan.order).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    const under = (g: number, i: number): boolean => {
      for (let x = i; x >= 0; x = springs.parent[x]!) if (x === g) return true;
      return false;
    };
    // Endpoint e's range holds exactly the leaves under its tree node.
    const treeIdOf = new Map<number, number>();
    for (let s = 0; s < springs.source.length; s++) {
      treeIdOf.set(plan.source[s]!, springs.source[s]!);
      treeIdOf.set(plan.target[s]!, springs.target[s]!);
    }
    for (const [e, g] of treeIdOf) {
      const range = Array.from(plan.order.subarray(plan.rangeStart[e]!, plan.rangeStart[e]! + plan.rangeCount[e]!)).sort((a, b) => a - b);
      expect(range).toEqual(Array.from({ length: n }, (_, i) => i).filter((i) => under(g, i)));
      expect(plan.rowScale[e]).toBeCloseTo(1 / range.length, 6);
    }
    // A leaf's chain is exactly the endpoints enclosing it, innermost first.
    for (let i = 0; i < n; i++) {
      const chain: number[] = [];
      for (let e = plan.leafEndpoint[i]!; e !== 0xffffffff; e = plan.endpointParent[e]!) chain.push(treeIdOf.get(e)!);
      const want = [...treeIdOf.values()].filter((g) => under(g, i)).sort((a, b) => a - b);
      expect(chain).toEqual(want);
      expect(chain.length).toBeLessThanOrEqual(plan.maxChain);
    }
  });
});
