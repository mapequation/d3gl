/**
 * Export equivalence: the WebGL `toSVG()` vs the Canvas `toSVG()`, PIXEL-diffed (#271).
 *
 * `backend-equivalence.browser.test.ts` (its sibling) proves the three backends *render* a Scene
 * identically. It cannot cover the WebGL **export**, because that document is not produced by the
 * render path at all: the network's glyphs live in GPU-instanced lanes with no retained Scene, so
 * `toSVG()` reconstructs them through {@link instancedVectorLayers} (`core/instanced-vector.ts`,
 * #200/#268) — a converter the screen never exercises. Until now it was pinned only by unit tests on
 * its geometry and by *element counts* against the Canvas export, which agree even when a coordinate
 * is wrong.
 *
 * The risky branch is the **screen `sizeMode` bake**. Constant-pixel terms — the arrowhead's
 * node-boundary setback, the half-arrow's taper and bend — are non-linear in the zoom, so they must be
 * solved in pixel space at the export `k` and emitted ÷k, not scaled with it. A wrong bake produces a
 * plausible file with the right element count and the glyphs a few px off, growing with zoom. Hence:
 * every case runs at **two different `k`**, and the world-`sizeMode` twin runs beside it as the
 * control (where `bake = 1` and the bug cannot appear).
 *
 * Bordered nodes are deliberately absent: WebGL exports one stroked ring, the Scene path two stacked
 * discs (AGENTS.md § Backend compositing equivalence, #269). That divergence is pinned by
 * `network/__tests__/network-export.browser.test.ts`; mixing it in here would mask a real bake error
 * behind a known one.
 */
import { describe, it, expect } from "vitest";
import { network, type Network, type NetworkStyle } from "../network/index.js";
import { buildGraph, type NetworkGraph } from "../network/graph.js";
import { diffExports, rasterizeSVG, diffPixels } from "./__tests__/backend-equivalence-harness.js";

const W = 320;
const H = 320;

/** The two zoom levels every case runs at. Both ≠ 1 (at k = 1 the bake is the identity, so a
 *  single-zoom test proves nothing) and far enough apart that a term scaled with k instead of baked
 *  at k lands in a visibly different place at one of them. */
const ZOOMS = [1.8, 3.2] as const;

/** Zoom about the viewport centre, so the fixture stays framed at every k. */
function zoomAbout(k: number): { k: number; x: number; y: number } {
  return { k, x: (W / 2) * (1 - k), y: (H / 2) * (1 - k) };
}

/** 6 nodes inside a ~90-unit box around the viewport centre — still fully in view at k = 3.2
 *  (the visible world box is then 100 units wide), so nothing is clipped away from the diff. */
const POS = new Float32Array([120, 130, 200, 125, 160, 178, 125, 202, 205, 200, 160, 116]);
/** 7 directed links: a cycle, two chords, and the reciprocal pair 1↔2 that makes the half-arrow
 *  glyph nest around a shared centre curve (its most bake-sensitive configuration). */
const SOURCE = [0, 1, 2, 3, 4, 2, 1];
const TARGET = [1, 2, 3, 4, 2, 1, 5];

function graph(directed: boolean): NetworkGraph {
  return buildGraph({ nodeCount: 6, source: SOURCE, target: TARGET, directed });
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

/**
 * Export one view as SVG through the given backend: same data, same style, same transform.
 *
 * `syncScreenGeometry()` is the documented pre-export step for the retained (Canvas/SVG) backends —
 * their Scene cannot re-solve a screen-space shape per frame, so the bake is refreshed on demand. The
 * WebGL side needs no equivalent: `toSVG()` re-selects each lane at the live transform.
 */
async function exportSVG(backend: "webgl" | "canvas", style: NetworkStyle, k: number): Promise<string> {
  const net: Network = network(host(), { width: W, height: H, backend });
  await net.whenReady();
  net
    .data(graph(style.directed === true))
    .style(style)
    .layout({ backend: "positions", positions: POS });
  net.setTransform(zoomAbout(k));
  net.syncScreenGeometry();
  const svg = net.toSVG();
  net.destroy();
  return svg;
}

/** Diff the two backends' export of the same view. Position-tolerant (radius 1) as the harness
 *  documents — the two documents describe the same shapes but round their coordinates differently. */
async function exportDiff(style: NetworkStyle, k: number): Promise<{ fraction: number; considered: number }> {
  const [gl, cv] = await Promise.all([exportSVG("webgl", style, k), exportSVG("canvas", style, k)]);
  const d = await diffExports(gl, cv, W, H, { radius: 1 });
  return { fraction: d.fraction, considered: d.considered };
}

// The link families the issue names, each in a variant that puts real ink on the canvas. Colours are
// pinned so a style default drifting apart between the two paths can't quietly mask a geometry diff.
const PAINT = { nodeFill: "#1f77b4", linkStroke: "#444444" } as const;
const STRAIGHT: NetworkStyle = { ...PAINT, directed: false, linkStyle: "line", linkBend: 0, nodeRadius: 7, linkWidth: 3 };
const ARROWS: NetworkStyle = { ...PAINT, directed: true, linkStyle: "line", linkBend: 0, nodeRadius: 7, linkWidth: 2.5, arrowSize: 9 };
const BENT_ARROWS: NetworkStyle = { ...ARROWS, linkBend: 0.18 };
const HALF_ARROWS: NetworkStyle = { ...PAINT, directed: true, linkStyle: "half-arrow", linkBend: 14, nodeRadius: 8, linkWidth: 5 };

const CASES: { name: string; style: NetworkStyle }[] = [
  { name: "straight links", style: STRAIGHT },
  { name: "arrows (straight)", style: ARROWS },
  { name: "arrows (bent — the end-tangent branch)", style: BENT_ARROWS },
  { name: "half-arrows", style: HALF_ARROWS },
];

/**
 * Ceiling on the mismatching share of the exported ink. Every case below currently measures
 * **exactly 0.00000** — the two documents describe the same shapes and the same rasterizer draws
 * them, so there is no cross-rasterizer noise floor to absorb (unlike the live-render harness, where
 * WebGL's tessellated stroke lands ~1px off Canvas's native stroker). 0.5% is headroom for coordinate
 * rounding, not for a divergence. Injected screen-mode bake errors measured, for calibration:
 * scaling the arrow's px setback with `k` instead of baking it → 11.0-21.6%; scaling the half-arrow's
 * px bend with `k` → 56.2-72.3%; a bare **2px** tip offset → 1.6-4.0%. Each left the world-`sizeMode`
 * twin at 0, which is the point: only the baked branch moves.
 */
const CEILING = 0.005;

describe("export equivalence: WebGL toSVG() vs Canvas toSVG() (#271)", () => {
  for (const mode of ["world", "screen"] as const) {
    for (const { name, style } of CASES) {
      for (const k of ZOOMS) {
        it(`${mode} sizeMode, ${name}, k=${k}`, async () => {
          const d = await exportDiff({ ...style, sizeMode: mode }, k);
          // Sanity: the view actually has glyphs in it (a blank export would diff perfectly).
          expect(d.considered).toBeGreaterThan(1500);
          expect(d.fraction).toBeLessThan(CEILING);
        });
      }
    }
  }
});

describe("export equivalence: the diff is sensitive to the screen-mode bake (#271)", () => {
  // Non-vacuity, part 1 — the screen-mode export is genuinely a DIFFERENT document from the
  // world-mode one at the same k. Without this, a bug that silently ignored `sizeMode` (making both
  // branches emit world geometry) would sail through every case above.
  it("screen and world sizeMode export materially different geometry at the same k", async () => {
    const k = ZOOMS[1];
    const [screen, world] = await Promise.all([
      exportSVG("webgl", { ...HALF_ARROWS, sizeMode: "screen" }, k),
      exportSVG("webgl", { ...HALF_ARROWS, sizeMode: "world" }, k),
    ]);
    const [ps, pw] = await Promise.all([rasterizeSVG(screen, W, H), rasterizeSVG(world, W, H)]);
    // At k = 3.2 a constant-px glyph is ~3× smaller than its world-sized twin: a large divergence.
    expect(diffPixels(ps, pw, { radius: 1 }).fraction).toBeGreaterThan(0.3);
  });

  // Non-vacuity, part 2 — the arrowheads whose bake this issue is about carry enough of the exported
  // ink that displacing them clears the 0.5% ceiling several times over (the injected 2px tip offset
  // scored 1.6-4.0%, i.e. 3-8×). Measured as the diff between the directed export (heads on) and the
  // undirected one (heads off) at the deeper zoom.
  it("arrowheads are a large share of the exported ink, so a displaced head cannot hide", async () => {
    const k = ZOOMS[1];
    const [heads, noHeads] = await Promise.all([
      exportSVG("webgl", { ...ARROWS, sizeMode: "screen" }, k),
      exportSVG("webgl", { ...ARROWS, sizeMode: "screen", directed: false }, k),
    ]);
    const [ph, pn] = await Promise.all([rasterizeSVG(heads, W, H), rasterizeSVG(noHeads, W, H)]);
    expect(diffPixels(ph, pn, { radius: 1 }).fraction).toBeGreaterThan(0.05);
  });
});
