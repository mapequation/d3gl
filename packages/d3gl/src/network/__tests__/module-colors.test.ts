import { describe, it, expect, vi, beforeEach } from "vitest";
import { hcl } from "d3-color";
import { moduleColors, type ModuleColorOptions, type ModulePathNode } from "../module-colors.js";

// Count HCL conversions (#428): a colour is a property of a module, so moduleColors converts once per
// module that holds a node — never once per node, which is what made it the largest single cost of
// loading a 325k-node map.
const conversions = vi.hoisted(() => ({ count: 0 }));
vi.mock("d3-color", async (importOriginal) => {
  const mod = await importOriginal<typeof import("d3-color")>();
  const hcl = new Proxy(mod.hcl, {
    apply(target, self, args) {
      conversions.count++;
      return Reflect.apply(target, self, args);
    },
  });
  return { ...mod, hcl };
});

beforeEach(() => {
  conversions.count = 0;
});

/** Deterministic LCG in [0, 1). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Random ragged hierarchy: depth 1–5, branch ids 1–4 (so some top-level leaves), records in shuffled id order. */
function randomRecords(seed: number, n: number): ModulePathNode[] {
  const rng = makeRng(seed);
  const ids = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = ids[i] ?? 0;
    ids[i] = ids[j] ?? 0;
    ids[j] = t;
  }
  return ids.map((id) => ({ id, path: Array.from({ length: 1 + Math.floor(rng() * 5) }, () => 1 + Math.floor(rng() * 4)) }));
}

/** Lexicographic path order — the order of an Infomap `.tree` file. */
function comparePaths(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  for (let d = 0; d < n; d++) if (a[d] !== b[d]) return (a[d] ?? 0) - (b[d] ?? 0);
  return a.length - b.length;
}

/** Distinct enclosing modules (path minus its last entry) across the records. */
function enclosingModules(records: readonly ModulePathNode[]): number {
  return new Set(records.map((r) => Array.from(r.path).slice(0, -1).join(":"))).size;
}

/**
 * The pre-#428 implementation, kept verbatim as the reference: ":"-joined prefix keys for every prefix of
 * every node, and one HCL conversion per node. Its output defines the expected colours.
 */
function referenceModuleColors(nodes: ArrayLike<ModulePathNode>, opts: ModuleColorOptions = {}): string[] {
  const L = opts.lightness ?? 65;
  const C = opts.chroma ?? 48;
  const rotate = opts.rotate ?? 20;
  const n = nodes.length;
  const prefixKey = (path: ArrayLike<number>, len: number): string => {
    let s = "";
    for (let i = 0; i < len; i++) s += (i ? ":" : "") + path[i];
    return s;
  };
  const childSets = new Map<string, Set<number>>();
  for (let r = 0; r < n; r++) {
    const { path } = nodes[r]!;
    for (let d = 0; d + 1 < path.length; d++) {
      const k = prefixKey(path, d);
      let set = childSets.get(k);
      if (!set) childSets.set(k, (set = new Set()));
      set.add(path[d]!);
    }
  }
  const ordinals = new Map<string, Map<number, number>>();
  for (const [k, set] of childSets) {
    const ord = new Map<number, number>();
    [...set].sort((a, b) => a - b).forEach((c, i) => ord.set(c, i));
    ordinals.set(k, ord);
  }
  const out = new Array<string>(n);
  for (let r = 0; r < n; r++) {
    const { id, path } = nodes[r]!;
    let a = 0;
    let b = 360;
    for (let d = 0; d + 1 < path.length; d++) {
      const ord = ordinals.get(prefixKey(path, d))!;
      const span = (b - a) / ord.size;
      a += ord.get(path[d]!)! * span;
      b = a + span;
    }
    out[id] = hcl((a + b) / 2 + rotate, C, L).formatHex();
  }
  return out;
}

describe("moduleColors", () => {
  it("gives every node its enclosing module's arc-centre hue, identical to the reference", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const records = randomRecords(seed, 150 + seed * 211);
      expect(moduleColors(records)).toEqual(referenceModuleColors(records));
    }
  });

  it("is identical to the reference on records in tree order, and with custom options", () => {
    const opts = { lightness: 62, chroma: 58, rotate: -40 };
    for (let seed = 7; seed <= 10; seed++) {
      const records = randomRecords(seed, 300 + seed * 97).sort((a, b) => comparePaths(a.path, b.path));
      expect(moduleColors(records)).toEqual(referenceModuleColors(records));
      expect(moduleColors(records, opts)).toEqual(referenceModuleColors(records, opts));
    }
  });

  it("splits the hue circle among top modules, and a parent's arc among its sub-modules", () => {
    const colors = moduleColors([
      { id: 0, path: [1, 1, 1] },
      { id: 1, path: [1, 2, 1] },
      { id: 2, path: [2, 1] },
      { id: 3, path: [1, 1, 2] },
    ]);
    const hue = (i: number) => hcl(colors[i] ?? "").h;
    expect(colors[3]).toBe(colors[0]); // same enclosing module [1,1] → same colour
    // Top module 1 owns [0°, 180°) (+20° rotation): its sub-modules sit at 45° and 135°; top module 2 at 270°.
    expect(hue(0)).toBeCloseTo(65, 0);
    expect(hue(1)).toBeCloseTo(155, 0);
    expect(hue(2)).toBeCloseTo(290, 0);
  });

  it("converts one colour per module that holds a node, not one per node", () => {
    const records = randomRecords(3, 4000).sort((a, b) => comparePaths(a.path, b.path));
    const colors = moduleColors(records);
    expect(colors.length).toBe(4000);
    expect(conversions.count).toBeGreaterThan(0);
    expect(conversions.count).toBeLessThanOrEqual(enclosingModules(records));
    expect(conversions.count).toBeLessThan(records.length / 4);
  });
});
