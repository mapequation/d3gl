import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";

/**
 * #191 (engine wiring): `net.lod({ modules })` with **no `expandPx`** must reach the cut as
 * "no explicit threshold", so the tree-adaptive default applies and the opening view is a map of
 * modules. The node test pins the cut itself; this one pins the path through the engine, observed
 * through `labels({ labelOf })`'s `info.aggregate` — the public read-out of what the frontier holds.
 */

const W = 400;
const H = 400;
const MODULES = 6;
const MEMBERS = 20;

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

const labelEls = (h: HTMLElement) => [...h.querySelectorAll<HTMLElement>("[data-label-id]")];

/** Six ~70px-wide clusters spread over the 400x400 view — a module map at `k = 1`. */
function clusters(): { positions: Float32Array; modules: ModuleNode[]; source: number[]; target: number[] } {
  const positions = new Float32Array(MODULES * MEMBERS * 2);
  const modules: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  for (let m = 0; m < MODULES; m++) {
    const cx = 70 + (m % 3) * 130;
    const cy = 110 + Math.floor(m / 3) * 180;
    for (let j = 0; j < MEMBERS; j++) {
      const id = m * MEMBERS + j;
      const a = (2 * Math.PI * j) / MEMBERS;
      const r = 12 + 23 * ((j % 5) / 4); // 12..35px from the centre
      positions[2 * id] = cx + r * Math.cos(a);
      positions[2 * id + 1] = cy + r * Math.sin(a);
      modules.push({ id, path: [m + 1, j + 1] });
      if (j > 0) {
        source.push(m * MEMBERS);
        target.push(id);
      }
    }
    if (m > 0) {
      source.push((m - 1) * MEMBERS);
      target.push(m * MEMBERS);
    }
  }
  return { positions, modules, source, target };
}

async function frontierLabels(expandPx?: number): Promise<{ h: HTMLElement; destroy: () => void; texts: string[]; source: string }> {
  const { positions, modules, source, target } = clusters();
  const h = host();
  const net = network(h, { width: W, height: H });
  await net.whenReady();
  const g = buildGraph({ nodeCount: MODULES * MEMBERS, source, target });
  net
    .data(g)
    .lod(expandPx === undefined ? { modules, declutter: false } : { modules, expandPx, declutter: false })
    .layout({ backend: "positions", positions });
  net.labels({ labelOf: (_id, info) => (info.aggregate ? "agg" : "leaf") });
  net.setTransform({ k: 1, x: 0, y: 0 }); // the whole map framed in the 400x400 view
  const texts = labelEls(h).map((e) => e.textContent ?? "");
  return {
    h,
    destroy: () => {
      net.destroy();
      h.remove();
    },
    texts,
    source: net.lodSource,
  };
}

describe("adaptive default expandPx through the engine (#191)", () => {
  it("lod({ modules }) with no expandPx opens on aggregates", async () => {
    const { destroy, texts, source } = await frontierLabels();
    expect(source).toBe("modules");
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((t) => t === "agg")).toBe(true);
    destroy();
  });

  it("an explicit expandPx still means an absolute footprint — 48px expands the same modules to leaves", async () => {
    const { destroy, texts } = await frontierLabels(48);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((t) => t === "leaf")).toBe(true);
    destroy();
  });
});
