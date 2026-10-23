import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph } from "../graph.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames, zoomSteps } from "../../__tests__/engine-sweep.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { InstancedLayer } from "../../core/index.js";

/**
 * Per-frame guard for the holders of an LOD selection (#538, docs/agents/performance.md) at ≈1M nodes, LOD on.
 * A selected node collapsed into a module the cut draws rings that module faintly and keeps it undimmed. The
 * holders (every strict ancestor of a selected node) are marked once per selection or tree change; a frame
 * reads one flag per frontier glyph, in the node `selected` flags and in the highlight lane's visible set.
 *
 * A module tree (two levels of square blocks, as Infomap gives a grid), every 97th node selected, two legs on one
 * engine (#287), each beside the same sweep with nothing selected:
 *   1. **Modules drawn** — zoomed out over the module cut with declutter: the frames really draw faint rings.
 *   2. **≈N visible** — `expandPx` ≈ 0 and no declutter, so the cut draws every leaf (the whole grid in view):
 *      the frontier the flag reads run over is ≈ N, the case the per-frame rule says LOD must not be let off.
 * Asserted: the holders are never re-marked by a frame (the signature: one marking per selection), no GPU buffer
 * created or destroyed, a per-frame upload the selection grows by at most one ring instance per drawn glyph,
 * and a frame ceiling per leg. LOD off has no holders (every node is drawn): `network-selection-sweep-1m-perf`
 * covers that state.
 */

const N = perfN(1_000_000, { max: 1_000_000 });
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
/** Square blocks of leaves: a bottom module is BLOCK × BLOCK leaves, a top module BLOCK × BLOCK bottom ones. */
const BLOCK = 10;
const SPACING = 8;
const W = 1280;
const H = 1280;
const SELECTED = Array.from({ length: Math.ceil(N / 97) }, (_, i) => i * 97);
/** Zoomed out, where the cut draws modules (the grid spans COLS × 8 world units). */
const OUT_STEPS = zoomSteps(W, H, [0.1, 0.2, 0.4, 0.8]).map((t) => centred(t.k));
/** The whole grid in view at 1.28 px a leaf: with 0.5 px leaves every one clears its neighbours. */
const ALL_STEPS = [centred(1280 / (COLS * SPACING))];

/** Per-frame upload a selection may add per drawn glyph: 2× the ring overlay's 24-byte instance. Deterministic. */
const RING_BYTES_PER_GLYPH = 48;
// Measured on an M1 Max under a load average of 20-30 (local headless Chromium, best of 3 for the modules leg):
// the modules leg ≈7 ms (≈4 ms with nothing selected), its frontier screen-bounded (≈10k glyphs); the
// all-leaves leg 0.55-0.75 s at 1M drawn (0.11 s with nothing selected: a selection's existing per-frame
// ancestor walk, #162, is most of that; the holders' flag reads measured +12 ms of it, interleaved). Ceilings
// ≈5× those, with the all-leaves one linear in N: they catch an order-of-magnitude regression; the holders'
// own signature (never re-marked by a frame) is the count above.
const FRAME_MS_MODULES = perfBudget(40);
const FRAME_MS_ALL = perfBudget(200 + (3000 * N) / 1_000_000);

function centred(k: number): { k: number; x: number; y: number } {
  const c = (COLS * SPACING) / 2;
  return { k, x: W / 2 - c * k, y: H / 2 - c * k };
}

/**
 * A grid of leaves in two levels of square modules (as an Infomap tree of the grid's blocks), each row a chain
 * of links. Leaf ids run block by block, so a module's leaves are contiguous.
 */
function fixture(n: number): { graph: ReturnType<typeof buildGraph>; positions: Float32Array; modules: { id: number; path: number[] }[] } {
  const positions = new Float32Array(n * 2);
  const modules: { id: number; path: number[] }[] = [];
  const top = BLOCK * BLOCK;
  const tops = Math.ceil(COLS / top);
  let id = 0;
  const at = new Int32Array(COLS * COLS).fill(-1); // grid cell → leaf id
  for (let ty = 0; ty < tops; ty++)
    for (let tx = 0; tx < tops; tx++)
      for (let by = 0; by < BLOCK; by++)
        for (let bx = 0; bx < BLOCK; bx++)
          for (let y = 0; y < BLOCK; y++)
            for (let x = 0; x < BLOCK; x++) {
              const gx = tx * top + bx * BLOCK + x;
              const gy = ty * top + by * BLOCK + y;
              if (gx >= COLS || gy >= COLS || id >= n) continue;
              positions[id * 2] = gx * SPACING;
              positions[id * 2 + 1] = gy * SPACING;
              modules.push({ id, path: [ty * tops + tx + 1, by * BLOCK + bx + 1, y * BLOCK + x + 1] });
              at[gy * COLS + gx] = id++;
            }
  const source: number[] = [];
  const target: number[] = [];
  for (let gy = 0; gy < COLS; gy++)
    for (let gx = 0; gx + 1 < COLS; gx++) {
      const a = at[gy * COLS + gx] ?? -1;
      const b = at[gy * COLS + gx + 1] ?? -1;
      if (a >= 0 && b >= 0) {
        source.push(a);
        target.push(b);
      }
    }
  return { graph: buildGraph({ nodeCount: id, source, target, directed: false }), positions: positions.subarray(0, id * 2), modules };
}

/** Counts, per sweep, the faint selection rings and the nodes the backend was handed. */
class RingSpy {
  faint = 0;
  nodes = 0;
  private readonly origUpdate = WebGLBackend.prototype.updateInstancedLayer;
  private readonly origSet = WebGLBackend.prototype.setInstancedLayer;
  constructor() {
    const spy = this;
    const count = (l: InstancedLayer): void => {
      if (l.primitive !== "circles") return;
      if (l.name === "nodes") spy.nodes = Math.max(spy.nodes, l.circles.count);
      if (l.name !== "network-highlight:ring") return;
      const c = l.circles.borderColors;
      for (let i = 0; c && i < l.circles.count; i++) if ((c[i * 4 + 3] ?? 255) < 255) spy.faint++;
    };
    WebGLBackend.prototype.updateInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
      count(layer);
      spy.origUpdate.call(this, layer);
    };
    WebGLBackend.prototype.setInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
      count(layer);
      spy.origSet.call(this, layer);
    };
  }
  reset(): void {
    this.faint = 0;
    this.nodes = 0;
  }
  restore(): void {
    WebGLBackend.prototype.updateInstancedLayer = this.origUpdate;
    WebGLBackend.prototype.setInstancedLayer = this.origSet;
  }
}

interface Leg {
  worstFrameMs: number;
  frames: number;
  uploaded: number;
  created: number;
  deleted: number;
  faint: number;
  /** The largest node layer a frame drew: the frontier. */
  nodes: number;
}

describe(`network() LOD selection holders (#538) at N=${N.toLocaleString()}`, () => {
  let net: Network;
  let host: HTMLElement;
  const buffers = new GlBufferSpy();
  const rings = new RingSpy();
  const legs: Record<"modulesNone" | "modulesSelected" | "allNone" | "allSelected", Leg> = {} as never;
  let holderBuildsInSweeps = -1;
  let holders = 0;

  const run = (steps: typeof OUT_STEPS, reps = 3): Leg => {
    rings.reset();
    const before = buffers.mark();
    const { worstFrameMs, frames } = sweepFrames(steps, (t) => net.setTransform(t), reps);
    const used = buffers.since(before);
    return { worstFrameMs, frames, uploaded: used.uploadedBytes, created: used.created, deleted: used.deleted, faint: rings.faint, nodes: rings.nodes };
  };

  beforeAll(async () => {
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const { graph, positions, modules } = fixture(N);
    net
      .data(graph)
      .style({ nodeRadius: 3, sizeMode: "screen", nodeFill: "rgb(59,130,246)", linkStroke: "rgb(203,213,225)" })
      .lod({ modules, declutter: true, maxAggregateRadius: 24 })
      .layout({ backend: "positions", positions });
    net.interactive({ selectable: true });

    // Leg 1: modules drawn. Each sweep runs once first, so a layer's one-time growth stays out of the counts.
    run(OUT_STEPS);
    legs.modulesNone = run(OUT_STEPS);
    net.select("nodes", SELECTED); // a registration event: the holders are marked here
    let builds = net.holderStats.builds;
    run(OUT_STEPS);
    legs.modulesSelected = run(OUT_STEPS);
    holderBuildsInSweeps = net.holderStats.builds - builds;
    holders = net.holderStats.holders;

    // Leg 2: ≈N visible, every leaf in view drawn; one frame a run (a frame draws the whole graph).
    net.select("nodes", null);
    net.style({ nodeRadius: 0.5 }).lod({ modules, expandPx: 1e-6, maxAggregateRadius: 24, declutter: false });
    run(ALL_STEPS, 1);
    legs.allNone = run(ALL_STEPS, 1);
    net.select("nodes", SELECTED);
    builds = net.holderStats.builds;
    run(ALL_STEPS, 1);
    legs.allSelected = run(ALL_STEPS, 1);
    holderBuildsInSweeps += net.holderStats.builds - builds;
    for (const [name, l] of Object.entries(legs))
      console.log(`  ${name}: worst ${l.worstFrameMs.toFixed(2)} ms, ${(l.uploaded / l.frames / 1024).toFixed(0)} KB/frame, frontier ${l.nodes.toLocaleString()}, ${l.faint} faint rings, buffers +${l.created}/-${l.deleted}`);
  }, perfBudget(300_000 + N / 2));

  afterAll(() => {
    rings.restore();
    buffers.restore();
    net?.destroy();
    host?.remove();
  });

  it("the legs draw what they are for (non-vacuity)", () => {
    expect(holders, "the selection marked no holder").toBeGreaterThan(0);
    expect(legs.modulesSelected.faint, "the modules leg drew no faint ring: no module holding a selected node was on screen").toBeGreaterThan(0);
    expect(legs.allSelected.nodes, "the all-leaves leg did not draw ≈N glyphs").toBeGreaterThan(0.9 * N);
  });

  it("the holders are marked at the select(), never by a frame", () => {
    expect(holderBuildsInSweeps).toBe(0);
  });

  it("a frame churns no buffer, and the faint rings add O(drawn) bytes", () => {
    for (const [name, sel, none] of [["modules", legs.modulesSelected, legs.modulesNone], ["all leaves", legs.allSelected, legs.allNone]] as const) {
      expect(sel.created, `${name}: GPU buffers created in the selected sweep`).toBe(0);
      expect(sel.deleted, `${name}: GPU buffers destroyed in the selected sweep`).toBe(0);
      // What the selection adds per frame is the ring overlay: 24 B an instance, at most one per drawn glyph.
      const added = sel.uploaded / sel.frames - none.uploaded / none.frames;
      expect(added, `${name}: ${added.toLocaleString()} B more per frame with the selection`).toBeLessThan(RING_BYTES_PER_GLYPH * sel.nodes);
    }
  });

  it("frames stay under their ceilings", () => {
    expect(legs.modulesSelected.worstFrameMs, `modules leg, ${SELECTED.length.toLocaleString()} selected: worst frame`).toBeLessThan(FRAME_MS_MODULES);
    expect(legs.allSelected.worstFrameMs, `all leaves (${legs.allSelected.nodes.toLocaleString()} drawn), ${SELECTED.length.toLocaleString()} selected: worst frame`).toBeLessThan(FRAME_MS_ALL);
  });
});
