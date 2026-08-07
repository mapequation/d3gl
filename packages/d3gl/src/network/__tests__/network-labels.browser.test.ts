import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

const labelEls = (h: HTMLElement) => [...h.querySelectorAll<HTMLElement>("[data-label-id]")];

// N7b: network.labels() shows a handful of importance-ranked labels on the LOD frontier (HTML overlay),
// re-placing on pan/zoom. (Export into toSVG/toPNG is N7b-2.)
describe("network.labels() — frontier labels (#105 N7b)", () => {
  it("renders top-k frontier labels via labelOf, and clears on labels(false)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net.data(g).style({ directed: true }).lod({ modules, expandPx: 20 }).layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.labels({ max: 8, labelOf: (id, info) => (info.aggregate ? `mod${id}·${info.count}` : `n${id}`) });
    net.setTransform({ k: 1, x: 0, y: 0 }); // two module aggregates on the frontier

    const els = labelEls(h);
    expect(els.length).toBeGreaterThan(0);
    expect(els.length).toBeLessThanOrEqual(8);
    // At this zoom the frontier is module aggregates → labelOf's aggregate branch ran.
    expect(els.every((e) => /^mod\d+·\d+$/.test(e.textContent ?? ""))).toBe(true);

    net.labels(false);
    expect(labelEls(h).length).toBe(0);
    net.destroy();
    h.remove();
  });

  it("re-places labels on zoom: aggregates expand to per-leaf labels when zoomed in", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net.data(g).style({ directed: true }).lod({ modules, expandPx: 20 }).layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.labels({ max: 8, labelOf: (id, info) => (info.aggregate ? `agg` : `leaf${id}`) });

    net.setTransform({ k: 1, x: 0, y: 0 });
    expect(labelEls(h).some((e) => e.textContent === "agg")).toBe(true); // collapsed → aggregate labels

    net.setTransform({ k: 2, x: -100, y: -100 }); // zoom in: modules expand to leaves
    const leaves = labelEls(h).filter((e) => /^leaf\d+$/.test(e.textContent ?? ""));
    expect(leaves.length).toBeGreaterThan(0); // re-placed to per-leaf labels
    net.destroy();
    h.remove();
  });

  it("default has no cap: labels every visible aggregate; labelOf null skips leaves", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net.data(g).style({ directed: true }).lod({ modules, expandPx: 20 }).layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    // No `max` → show all; label only aggregates (null for leaves).
    net.labels({ labelOf: (_id, info) => (info.aggregate ? `${info.count}` : null) });
    net.setTransform({ k: 1, x: 0, y: 0 });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tree = (net as any).lodTree;
    const frontier = [...((net as any).instancedLanes.get("network").lane.visible as Uint32Array)];
    const aggregatesInView = frontier.filter((gid) => gid >= tree.leafCount);
    const els = labelEls(h);
    expect(els.length).toBe(aggregatesInView.length); // every aggregate labelled — no cap
    expect(els.every((e) => /^\d+$/.test(e.textContent ?? ""))).toBe(true); // counts only, leaves skipped
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
    h.remove();
  });

  it("no-LOD: ranks visible nodes by strength, capped at max", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    // Star: node 0 is the hub (degree 3, highest strength).
    const g = buildGraph({ nodeCount: 4, source: [0, 0, 0], target: [1, 2, 3], directed: false });
    net.data(g).style({ nodeRadius: 5 }).layout({ backend: "positions", positions: new Float32Array([100, 100, 30, 30, 170, 30, 100, 170]) });
    net.labels({ max: 2, labelOf: (id) => `n${id}` });
    net.setTransform({ k: 1, x: 0, y: 0 });

    const els = labelEls(h);
    expect(els.length).toBe(2); // capped at max
    expect(els.some((e) => e.textContent === "n0")).toBe(true); // the hub (highest strength) is shown
    net.destroy();
    h.remove();
  });

  it("thins a dense cluster: no two labels overlap, and the most important survives (#204)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    // 12 nodes packed into an ~18px box in the middle of the view. Every label ("label-N", ~40px
    // wide × 14px tall) would overprint every other one — the #204 unreadable stack.
    const N = 12;
    const positions = new Float32Array(2 * N);
    for (let i = 0; i < N; i++) {
      positions[2 * i] = 92 + (i % 4) * 6;
      positions[2 * i + 1] = 92 + Math.floor(i / 4) * 6;
    }
    const source: number[] = [];
    const target: number[] = [];
    for (let i = 1; i < N; i++) { source.push(0); target.push(i); } // node 0 = the hub (top strength)
    const g = buildGraph({ nodeCount: N, source, target, directed: false });
    net.data(g).style({ nodeRadius: 3 }).layout({ backend: "positions", positions });
    net.labels({ labelOf: (id) => `label-${id}` }); // uncapped: collision culling is the only thinning
    net.setTransform({ k: 1, x: 0, y: 0 });

    const els = labelEls(h);
    expect(els.length).toBeGreaterThan(0);
    expect(els.length).toBeLessThan(N); // the stack is thinned, not all 12 painted on top of each other

    // The acceptance criterion: no two RENDERED label boxes overlap (1px slack for rounding).
    const rects = els.map((e) => e.getBoundingClientRect());
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (!a || !b) continue;
        const hit = a.right - 1 > b.left && b.right - 1 > a.left && a.bottom - 1 > b.top && b.bottom - 1 > a.top;
        expect(`${els[i]?.textContent}×${els[j]?.textContent}:${hit}`).toBe(`${els[i]?.textContent}×${els[j]?.textContent}:false`);
      }
    }
    // Importance-ranked: the hub (highest strength) wins its collisions.
    expect(els.some((e) => e.textContent === "label-0")).toBe(true);
    net.destroy();
    h.remove();
  });

  it("labels come pre-styled by default; `style` overrides inline and restyles on re-call (#224)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false });
    net.data(g).style({ nodeRadius: 5 }).layout({ backend: "positions", positions: new Float32Array([60, 60, 140, 140]) });

    // Default: no className, no style → the built-in look lands on the overlay elements.
    net.labels({ labelOf: (id) => `n${id}` });
    net.setTransform({ k: 1, x: 0, y: 0 });
    let els = labelEls(h);
    expect(els.length).toBeGreaterThan(0);
    expect(els.every((e) => e.style.font.includes("11px"))).toBe(true); // DEFAULT_LABEL_STYLE
    expect(els.every((e) => e.style.textShadow.includes("3px"))).toBe(true); // the white halo

    // Re-call with a partial `style`: merged over the default, and the overlay is restyled.
    net.labels({ labelOf: (id) => `n${id}`, style: { color: "rgb(31, 41, 55)" } });
    els = labelEls(h);
    expect(els.every((e) => e.style.color === "rgb(31, 41, 55)")).toBe(true); // the override applied
    expect(els.every((e) => e.style.font.includes("11px"))).toBe(true); // the rest of the default kept
    net.destroy();
    h.remove();
  });
});
