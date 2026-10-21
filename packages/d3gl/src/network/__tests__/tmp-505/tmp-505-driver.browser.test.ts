// TEMP(#505): screenshot driver for the self-loop variant comparison. DELETE before the PR.
import { it } from "vitest";
import { page } from "vitest/browser";
import { network } from "../../network.js";
import { buildGraph } from "../../graph.js";
import { parseEdgeList } from "../../parse.js";
import { setSelfLoopPrototype, type SelfLoopOptions } from "../../self-loops.js";
import type { BackendType } from "../../../map/backend-factory.js";
import twoTri from "./post_two_triangles_selflinks.txt?raw";
import illDir from "./post_illustration_b_dir_selflinks.txt?raw";
import nine1 from "./post_ninetriangles_selflinks.txt?raw";
import nine2 from "./post_ninetriangles_selflinks2.txt?raw";

const OUT = "/Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/_review";
const W = 420;
const H = 420;

/** The edge lines of a Pajek-like file (drops the *Vertices block and the comments). */
function edgeLines(text: string): string {
  const out: string[] = [];
  let inEdges = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("*")) {
      inEdges = /^\*(edges|arcs|links)/i.test(line);
      continue;
    }
    if (inEdges) out.push(line);
  }
  return out.join("\n");
}

interface SceneSpec {
  name: string;
  text: string;
  directed: boolean;
}
const SCENES: Record<string, SceneSpec> = {
  twotri: { name: "twotri", text: edgeLines(twoTri), directed: false },
  illdir: { name: "illdir", text: edgeLines(illDir), directed: true },
  // Two real posterior samples of the same nine-triangle network, loaded together: every node has two self-links.
  nine2: { name: "nine2", text: `${edgeLines(nine1)}\n${edgeLines(nine2)}`, directed: false },
};

const positionsCache = new Map<string, Float32Array>();

async function shot(scene: SceneSpec, variant: string, opts: Partial<SelfLoopOptions>, backend: BackendType = "webgl", sizeMode: "world" | "screen" = "world", k = 1): Promise<void> {
  setSelfLoopPrototype(opts);
  const host = document.createElement("div");
  host.style.cssText = `width:${W}px;height:${H}px;background:#fff`;
  document.body.appendChild(host);
  const parsed = parseEdgeList(scene.text);
  const graph = buildGraph({ nodeCount: parsed.nodeCount, source: parsed.source, target: parsed.target, weight: parsed.weight, directed: scene.directed });
  const net = network(host, { width: W, height: H, backend });
  await net.whenReady();
  // Layout once per scene (positions only), then frame it and size everything in px ÷ the frame scale.
  let pos = positionsCache.get(scene.name);
  if (!pos) {
    net.data(graph).layout({ backend: "force", iterations: 600 });
    await net.whenSettled();
    pos = (net.positions ?? new Float32Array(0)).slice();
    positionsCache.set(scene.name, pos);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pos.length; i += 2) {
    const x = pos[i] ?? 0, y = pos[i + 1] ?? 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const k0 = Math.min((W - 160) / Math.max(1e-6, x1 - x0), (H - 160) / Math.max(1e-6, y1 - y0));
  const u = sizeMode === "screen" ? 1 : 1 / k0; // px → size units
  net.data(graph).style({
    directed: scene.directed,
    sizeMode,
    nodeRadius: { by: "strength", scale: (s: number) => (4 + 3 * Math.sqrt(s)) * u },
    nodeFill: "#7aa6d8",
    arrowSize: 4 * u,
    linkWidth: (w: number) => (0.6 + 2.4 * Math.sqrt(w)) * u,
    linkStroke: (w: number) => `rgba(40,40,60,${Math.min(0.9, 0.25 + 0.6 * w).toFixed(2)})`,
  });
  net.layout({ backend: "positions", positions: pos.slice() });
  const kk = k0 * k;
  net.setTransform({ k: kk, x: W / 2 - (kk * (x0 + x1)) / 2, y: H / 2 - (kk * (y0 + y1)) / 2 });
  net.syncScreenGeometry();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await page.screenshot({ element: host, path: `${OUT}/505-${scene.name}-${variant}.png` });
  net.destroy();
  host.remove();
}

it("renders the #505 variants", { timeout: 600_000 }, async () => {
  for (const s of [SCENES.twotri, SCENES.illdir]) {
    if (!s) continue;
    await shot(s, "teardrop-fixed", { shape: "teardrop", placement: "fixed" });
    await shot(s, "teardrop-away", { shape: "teardrop", placement: "away" });
    await shot(s, "circle-fixed", { shape: "circle", placement: "fixed" });
    await shot(s, "circle-away", { shape: "circle", placement: "away" });
  }
  const n = SCENES.nine2;
  if (n) {
    await shot(n, "sum", { shape: "teardrop", placement: "away", duplicates: "sum" });
    await shot(n, "nest", { shape: "teardrop", placement: "away", duplicates: "nest" });
    await shot(n, "circle-nest", { shape: "circle", placement: "away", duplicates: "nest" });
  }
  const d = SCENES.illdir;
  if (d) {
    await shot(d, "teardrop-away-canvas", { shape: "teardrop", placement: "away" }, "canvas");
    await shot(d, "teardrop-away-svg", { shape: "teardrop", placement: "away" }, "svg");
    for (const b of ["webgl", "canvas", "svg"] as const) {
      await shot(d, `teardrop-away-screen-${b}-k1`, { shape: "teardrop", placement: "away" }, b, "screen", 1);
      await shot(d, `teardrop-away-screen-${b}-k05`, { shape: "teardrop", placement: "away" }, b, "screen", 0.5);
    }
  }
});
