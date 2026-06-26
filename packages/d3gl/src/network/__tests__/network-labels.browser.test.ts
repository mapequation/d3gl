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
});
