import { describe, it, expect, vi, afterEach } from "vitest";
import { network, type Network, type NetworkHit } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import { buildGraph } from "../graph.js";
import type { ModulePathNode } from "../module-colors.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { InstancedHighlight, InstancedLayer } from "../../core/backend.js";
import type { HoverHit } from "../../map/base-engine.js";
import { decodeImage } from "../../map/__tests__/backend-equivalence-harness.js";

/**
 * State-network correctness across its three views (#494): optional modules, the app's module colours,
 * the both view's containers and dots, container interaction (#315), and the selection across a view
 * switch (#316). Behaviour through the public API, pixels through `toPNG()` (WebGL).
 *
 * Fixture (5 state nodes over 3 physical nodes):
 *  - physical 0: states 0 (module [1]) + 1 (module [2]) → a two-wedge pie
 *  - physical 1: states 2 + 4 (both module [1]) → a single-module disc
 *  - physical 2: state 3 (module [2]) → a single-module disc
 */
const S = 5;
const P = 3;
const POS = new Float32Array([50, 120, 150, 120, 100, 40]);
const W = 200;
const H = 200;

function fixture() {
  const graph = buildStateGraph({
    stateCount: S,
    stateToPhysical: [0, 0, 1, 2, 1],
    source: [0, 1, 4],
    target: [2, 3, 0],
    nodeFlow: [1, 1, 1, 1, 1],
    directed: false,
  });
  const modules: ModulePathNode[] = [
    { id: 0, path: [1, 1, 1] },
    { id: 1, path: [2, 1] },
    { id: 2, path: [1, 1, 2] },
    { id: 3, path: [2, 2] },
    { id: 4, path: [1, 2, 1] },
  ];
  return { graph, modules };
}

/** The app's palette: one colour per module path (as @mapequation/c3's `hierarchy().colorOf` gives). */
const PALETTE: Record<string, string> = {
  "1": "#d62728",
  "2": "#1f77b4",
  "1:1": "#ff7f0e",
  "1:2": "#9467bd",
};
const colorOf = (path: readonly number[]): string | undefined => PALETTE[path.join(":")];
const RGB: Record<string, [number, number, number]> = {
  "#d62728": [214, 39, 40],
  "#1f77b4": [31, 119, 180],
  "#ff7f0e": [255, 127, 14],
  "#9467bd": [148, 103, 189],
};

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

async function engine(h: HTMLElement, backend: "webgl" | "svg" = "webgl"): Promise<Network> {
  const net = network(h, { width: W, height: H, backend });
  await net.whenReady();
  return net;
}

/** Place the physical nodes and frame world == screen (k = 1). Supplied positions are the active view's graph's
 *  (#495): in the state view the physical ones are placed in the physical view, and the state view, never laid
 *  out, starts from its rosette around them. */
function place(net: Network): void {
  const view = net.stateView;
  if (view === "state") net.view("physical");
  net.layout({ backend: "positions", positions: POS });
  if (view === "state") net.view("state");
  net.setTransform({ k: 1, x: 0, y: 0 });
}

const frame = async (net: Network) => decodeImage(net.toPNG(), W, H);
function rgbaAt(buf: { width: number; data: Uint8Array }, x: number, y: number): [number, number, number, number] {
  const o = (Math.round(y) * buf.width + Math.round(x)) * 4;
  return [buf.data[o] ?? 0, buf.data[o + 1] ?? 0, buf.data[o + 2] ?? 0, buf.data[o + 3] ?? 0];
}
const near = (a: readonly number[], b: readonly number[], tol = 6): boolean => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);

interface Circle { cx: number; cy: number; r: number; stroked: boolean; outer: number }
/** Every `<circle>` of an export, with whether it carries a stroke ring (a container) or not (a plain dot). */
function circlesOf(svg: string): Circle[] {
  const out: Circle[] = [];
  for (const m of svg.matchAll(/<circle([^>]*)>/g)) {
    const attrs = m[1] ?? "";
    const num = (name: string): number => Number(new RegExp(`\\b${name}="([^"]+)"`).exec(attrs)?.[1] ?? NaN);
    const sw = num("stroke-width");
    const stroked = Number.isFinite(sw) && sw > 0;
    // A bordered circle exports on its ring's centreline (r·(1 − b/2), stroke r·b): `outer` is its radius.
    out.push({ cx: num("cx"), cy: num("cy"), r: num("r"), stroked, outer: num("r") + (stroked ? sw / 2 : 0) });
  }
  return out;
}

/** Where state node `s` is drawn in the active view (#495: the both view's dots have positions of their own). */
const statePos = (net: Network, s: number): [number, number] => [net.positions![2 * s]!, net.positions![2 * s + 1]!];

/** A screen point inside physical `p`'s container but clear of every state dot: the container's top edge. */
function containerPoint(net: Network, g: ReturnType<typeof fixture>["graph"], p: number): [number, number] {
  const cx = g.physical.positions[2 * p]!, cy = g.physical.positions[2 * p + 1]!;
  const containers = circlesOf(net.toSVG()).filter((c) => c.stroked);
  const own = containers.find((c) => Math.abs(c.cx - cx) < 0.01 && Math.abs(c.cy - cy) < 0.01);
  expect(own, `no container drawn at physical ${p}`).toBeDefined();
  // The exported ring's centreline radius r·(1 − b/2): 85% of it is inside the disc, past every dot.
  return [cx, cy - 0.85 * (own?.r ?? 0)];
}

function laneSpy() {
  const style = vi.spyOn(WebGLBackend.prototype, "styleInstancedLayer");
  const set = vi.spyOn(WebGLBackend.prototype, "setInstancedLayer");
  const update = vi.spyOn(WebGLBackend.prototype, "updateInstancedLayer");
  return {
    styled: (name: string): InstancedHighlight[] => style.mock.calls.filter(([n]) => n === name).map(([, h]) => h),
    emitted: (): string[] => [...set.mock.calls, ...update.mock.calls].map(([l]) => l.name),
    reset(): void {
      style.mockClear();
      set.mockClear();
      update.mockClear();
    },
  };
}
const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const ids = (hits: readonly HoverHit[]): number[] => hits.map((h) => h.id as number).sort((a, b) => a - b);

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("a state network without modules (#494, 1)", () => {
  it("stateNetwork() takes no modules: every view draws its nodes, no pies, the app's fill", async () => {
    const { graph } = fixture();
    const net = await engine(host());
    net.style({ nodeRadius: 6, nodeFill: "#1f77b4" }).stateNetwork(graph, { view: "physical" });
    place(net);
    let svg = net.toSVG();
    expect(circlesOf(svg).length, "physical view: one disc per physical node").toBe(P);
    expect(svg).not.toMatch(/<path[^>]*fill="rgba\(214/); // no pie wedges
    net.view("state");
    expect(circlesOf(net.toSVG()).length).toBe(S);
    net.view("both");
    svg = net.toSVG();
    expect(circlesOf(svg).filter((c) => c.stroked).length, "both view: one container per physical node").toBe(P);
    expect(circlesOf(svg).filter((c) => !c.stroked).length).toBe(S);
    // Every state dot takes the app's fill.
    const img = await frame(net);
    const [x, y] = statePos(net, 3);
    expect(near(rgbaAt(img, x, y).slice(0, 3), RGB["#1f77b4"]!), `state dot fill ${rgbaAt(img, x, y)}`).toBe(true);
    net.destroy();
  });
});

describe("the both view (#494, 2-3)", () => {
  it("draws its containers on the first frame, also when the app turned LOD on first", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    // The Navigator's order: the network with its view, then the app's LOD, then the layout.
    net.stateNetwork(graph, { modules, view: "both" }).lod({}).layout({ backend: "force" });
    const svg = net.toSVG();
    expect(circlesOf(svg).filter((c) => c.stroked).length, "containers missing on the first frame").toBe(P);
    expect(circlesOf(svg).filter((c) => !c.stroked).length, "state dots missing on the first frame").toBe(S);
    net.destroy();
  });

  it("sizes the state dots to their container: inside it, and at least a fifth of the room they share", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    // A screen-sized app style (the Navigator's): the both view still draws its dots in world units.
    net.style({ sizeMode: "screen", nodeRadius: 1 }).stateNetwork(graph, { modules, view: "both" });
    place(net);
    const circles = circlesOf(net.toSVG());
    const containers = circles.filter((c) => c.stroked);
    const dots = circles.filter((c) => !c.stroked);
    expect(dots.length).toBe(S);
    for (let s = 0; s < S; s++) {
      const p = graph.stateToPhysical[s]!;
      const [x, y] = statePos(net, s);
      const dot = dots.find((c) => Math.abs(c.cx - x) < 0.01 && Math.abs(c.cy - y) < 0.01);
      const box = containers.find((c) => Math.abs(c.cx - POS[2 * p]!) < 0.01 && Math.abs(c.cy - POS[2 * p + 1]!) < 0.01);
      expect(dot && box, `state ${s} or its container is not drawn`).toBeTruthy();
      if (!dot || !box) continue;
      const k = graph.physicalToState.offsets[p + 1]! - graph.physicalToState.offsets[p]!;
      const R = box.outer;
      expect(Math.hypot(x - box.cx, y - box.cy) + dot.r, `state ${s} pokes out of its container`).toBeLessThanOrEqual(R + 1e-3);
      expect(dot.r, `state ${s}'s dot is too small to see`).toBeGreaterThanOrEqual((0.2 * R) / Math.sqrt(k));
    }
    net.destroy();
  });

  it("the both view's dot radius never leaks into the other views, nor overwrites the app's style", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.style({ nodeRadius: 9, nodeFill: "#9467bd" }).stateNetwork(graph, { modules, view: "both" });
    place(net);
    net.view("physical");
    expect(circlesOf(net.toSVG()).map((c) => c.r), "physical view after both").toEqual([9, 9, 9]);
    net.view("state");
    expect(circlesOf(net.toSVG()).map((c) => c.r), "state view after both").toEqual([9, 9, 9, 9, 9]);
    // The app's fill held across every switch: a single-module disc in the physical view is the app's colour.
    net.view("both").view("physical");
    const img = await frame(net);
    expect(near(rgbaAt(img, POS[2]!, POS[3]!).slice(0, 3), RGB["#9467bd"]!), "the view switch overwrote nodeFill").toBe(true);
    net.destroy();
  });
});

describe("both-view containers are interactive (#494, 5; #315)", () => {
  it("a container is picked where no state dot is: level physical, its physical id, its state nodes as members", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.stateNetwork(graph, { modules, view: "both" });
    place(net);
    net.interactive({ selectable: true, hover: true });
    const [x, y] = containerPoint(net, graph, 1);
    const hit = net.pick(x, y);
    expect(hit?.layer).toBe("nodes");
    const datum = hit?.datum as NetworkHit;
    expect(datum.level).toBe("physical");
    expect(datum.physical).toBe(1);
    expect(datum.aggregate).toBe(true);
    expect(datum.count).toBe(2);
    expect(hit?.id).toBe(S + 1);
    expect((hit?.members?.() ?? []).map(Number).sort()).toEqual([2, 4]);
    // A state dot still wins over its container.
    const [sx, sy] = statePos(net, 2);
    const dotHit = net.pick(sx, sy);
    expect(dotHit?.id).toBe(2);
    expect((dotHit?.datum as NetworkHit).level).toBe("state");
    net.destroy();
  });

  it("a click selects the container as its state nodes; the highlight keeps it and dims the other containers", async () => {
    const { graph, modules } = fixture();
    const h = host();
    const net = await engine(h);
    net.stateNetwork(graph, { modules, view: "both" });
    place(net);
    net.interactive({ selectable: true });
    const before = await frame(net);
    const seen: HoverHit[][] = [];
    net.on("select", (hits) => seen.push(hits));
    const spy = laneSpy();
    spy.reset();

    const [x, y] = containerPoint(net, graph, 1);
    const [ox, oy] = containerPoint(net, graph, 2);
    const r = h.getBoundingClientRect();
    const ev = (type: string) => h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
    ev("pointerdown");
    ev("pointerup");

    const sel = net.selection();
    expect(sel.length).toBe(1);
    expect((sel[0]?.datum as NetworkHit).physical).toBe(1);
    expect((sel[0]?.members?.() ?? []).map(Number).sort()).toEqual([2, 4]);
    expect(seen.length, "no select event").toBeGreaterThan(0);
    // The containers joined the shader highlight (#315): their flags travel with the push, no re-emit.
    const flags = spy.styled("phys-container").map((u) => u.selected).filter((s): s is Uint8Array => !!s);
    expect([...(last(flags) ?? [])], "container flags").toEqual([0, 1, 0]);
    expect(spy.emitted().filter((n) => n === "nodes" || n === "phys-container"), "a selection re-emitted geometry").toEqual([]);
    const after = await frame(net);
    expect(rgbaAt(after, x, y), "the selected container changed").toEqual(rgbaAt(before, x, y));
    expect(rgbaAt(after, ox, oy)[3], "another container did not dim").toBeLessThan(rgbaAt(before, ox, oy)[3]);

    // Selecting one state node keeps its own container lit, dims the others (#315's acceptance).
    spy.reset();
    net.select("nodes", [3]);
    expect([...(last(spy.styled("phys-container").map((u) => u.selected).filter((s): s is Uint8Array => !!s)) ?? [])]).toEqual([0, 0, 1]);
    expect(spy.emitted().filter((n) => n === "nodes" || n === "phys-container"), "a selection re-emitted geometry").toEqual([]);
    const one = await frame(net);
    expect(rgbaAt(one, ox, oy), "the selected state node's container changed").toEqual(rgbaAt(before, ox, oy));
    expect(rgbaAt(one, x, y)[3], "another container did not dim").toBeLessThan(rgbaAt(before, x, y)[3]);
    net.destroy();
  });

  it("hovering a container lights it and its state dots and fades the rest (a uniform, no re-emit)", async () => {
    const { graph, modules } = fixture();
    const h = host();
    const net = await engine(h);
    net.stateNetwork(graph, { modules, view: "both" });
    place(net);
    net.interactive({ hover: { others: { opacity: 0.3 } } });
    const before = await frame(net);
    const spy = laneSpy();
    spy.reset();
    const [x, y] = containerPoint(net, graph, 1);
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
    expect(spy.styled("phys-container").some((u) => u.hoverGroup === S + 1 && u.dimActive)).toBe(true);
    expect(spy.emitted().filter((n) => n === "nodes" || n === "phys-container")).toEqual([]);
    const img = await frame(net);
    const [s2x, s2y] = statePos(net, 2);
    const [s3x, s3y] = statePos(net, 3);
    expect(rgbaAt(img, s2x, s2y), "the hovered container's state dot changed").toEqual(rgbaAt(before, s2x, s2y));
    expect(rgbaAt(img, s3x, s3y)[3], "another container's state dot did not fade").toBeLessThan(rgbaAt(before, s3x, s3y)[3]);
    net.destroy();
  });

  it("dragging a container moves its physical node and its state nodes", async () => {
    const { graph, modules } = fixture();
    const h = host();
    const net = await engine(h);
    net.stateNetwork(graph, { modules, view: "both" });
    place(net);
    net.interactive({ selectable: true, draggable: true });
    const [x, y] = containerPoint(net, graph, 1);
    const p0 = [graph.physical.positions[2]!, graph.physical.positions[3]!];
    const s0 = [statePos(net, 2), statePos(net, 4)];
    const other = statePos(net, 3);
    const r = h.getBoundingClientRect();
    const ev = (type: string, px: number, py: number) =>
      h.dispatchEvent(new PointerEvent(type, { clientX: r.left + px, clientY: r.top + py, bubbles: true, button: 0, pointerId: 1 }));
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    ev("pointerdown", x, y);
    for (let i = 1; i <= 4; i++) {
      ev("pointermove", x + 5 * i, y + 3 * i);
      await nextFrame();
    }
    ev("pointerup", x + 20, y + 12);
    expect(graph.physical.positions[2]! - p0[0]!).toBeCloseTo(20, 3);
    expect(graph.physical.positions[3]! - p0[1]!).toBeCloseTo(12, 3);
    // Each state node keeps its offset from its physical node (#495, #509: the packing does not follow the layout).
    for (const [k, s] of [2, 4].entries()) {
      const [sx, sy] = statePos(net, s);
      const before = [s0[k]![0] - p0[0]!, s0[k]![1] - p0[1]!];
      const after = [sx - graph.physical.positions[2]!, sy - graph.physical.positions[3]!];
      expect(Math.hypot(after[0]! - before[0]!, after[1]! - before[1]!), `state ${s} did not follow its physical node`).toBeLessThan(1e-3);
    }
    expect(statePos(net, 3), "another physical node's state moved").toEqual(other);
    // The container is drawn where its physical node went.
    const moved = circlesOf(net.toSVG()).filter((c) => c.stroked).find((c) => Math.abs(c.cx - (p0[0]! + 20)) < 0.01);
    expect(moved, "the container did not move").toBeDefined();
    net.destroy();
  });
});

describe("the selection across a view switch (#494, 6; #316)", () => {
  it("maps physical → all its state nodes, state → their physical nodes, and a container → its state nodes", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.stateNetwork(graph, { modules, view: "physical" });
    place(net);
    net.interactive({ selectable: { multi: true }, hover: true });
    const seen: HoverHit[][] = [];
    net.on("select", (hits) => seen.push(hits));

    net.select("nodes", [1]);
    net.view("both");
    expect(ids(net.selection()), "physical 1 → its state nodes").toEqual([2, 4]);
    expect(net.selection().every((h) => (h.datum as NetworkHit).level === "state")).toBe(true);
    expect(ids(last(seen) ?? []), "the mapped selection was not announced").toEqual([2, 4]);

    net.select("nodes", [3]);
    net.view("physical");
    expect(ids(net.selection()), "state 3 → physical 2").toEqual([2]);
    expect((net.selection()[0]?.datum as NetworkHit).level).toBe("physical");

    net.select("nodes", [0, 1]);
    net.view("state");
    expect(ids(net.selection()), "physical 0 and 1 → their four state nodes").toEqual([0, 1, 2, 4]);

    // #316's case: a selection made in the state view reads as its physical nodes in the physical view.
    net.select("nodes", [1]);
    net.view("physical");
    expect(ids(net.selection()), "state 1 → physical 0").toEqual([0]);
    net.view("state");

    net.view("both");
    net.select("nodes", [S + 2]); // physical 2's container
    net.view("state");
    expect(ids(net.selection()), "a container → its state nodes").toEqual([3]);
    net.destroy();
  });

  it("clears the hover on a view switch", async () => {
    const { graph, modules } = fixture();
    const h = host();
    const net = await engine(h);
    net.stateNetwork(graph, { modules, view: "physical" });
    place(net);
    net.interactive({ hover: { others: { opacity: 0.3 } } });
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + POS[2]!, clientY: r.top + POS[3]!, bubbles: true }));
    const spy = laneSpy();
    spy.reset();
    net.view("state");
    expect(last(spy.styled("nodes"))?.hoverGroup, "a stale hover survived the switch").toBe(-1);
    expect(last(spy.styled("nodes"))?.dimActive).toBe(false);
    net.destroy();
  });
});

describe("module colours from the app: nodeFill { by: 'module', color } (#494, 10)", () => {
  it("colours state dots, physical discs and pie wedges by the app's palette in every view, after every switch", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    let calls = 0;
    const color = (path: readonly number[]) => {
      calls++;
      return colorOf(path);
    };
    net.style({ nodeRadius: 12, nodeFill: { by: "module", color } }).stateNetwork(graph, { modules, view: "physical" });
    place(net);
    const check = async (view: "physical" | "state" | "both") => {
      net.view(view);
      const img = await frame(net);
      if (view === "physical") {
        // physical 1: a disc of its one pie-level module [1]; physical 2: [2].
        expect(near(rgbaAt(img, POS[2]!, POS[3]!).slice(0, 3), RGB["#d62728"]!), `physical 1 ${rgbaAt(img, POS[2]!, POS[3]!)}`).toBe(true);
        expect(near(rgbaAt(img, POS[4]!, POS[5]!).slice(0, 3), RGB["#1f77b4"]!)).toBe(true);
        // physical 0's pie: half [1] (state 0) and half [2] (state 1). Sample each half.
        const wedgeA = rgbaAt(img, POS[0]! + 6, POS[1]! + 3).slice(0, 3);
        const wedgeB = rgbaAt(img, POS[0]! - 6, POS[1]! - 3).slice(0, 3);
        const colours = [wedgeA, wedgeB];
        expect(colours.some((c) => near(c, RGB["#d62728"]!)), `pie wedges ${colours}`).toBe(true);
        expect(colours.some((c) => near(c, RGB["#1f77b4"]!)), `pie wedges ${colours}`).toBe(true);
      } else {
        // A state node takes its enclosing module's colour: 0 → [1,1], 2 → [1,1], 4 → [1,2], 1 and 3 → [2].
        const want: Record<number, string> = { 0: "#ff7f0e", 1: "#1f77b4", 2: "#ff7f0e", 3: "#1f77b4", 4: "#9467bd" };
        for (const [s, hex] of Object.entries(want)) {
          const [x, y] = statePos(net, Number(s));
          expect(near(rgbaAt(img, x, y).slice(0, 3), RGB[hex]!), `${view} view: state ${s} is ${rgbaAt(img, x, y)}, want ${hex}`).toBe(true);
        }
      }
    };
    await check("physical");
    await check("both");
    await check("state");
    await check("physical");
    await check("both");
    // Each resolution asks once per module, never per node: 4 state-level + 2 pie-level modules here.
    expect(calls, "the accessor ran per node, or per frame").toBeLessThanOrEqual(6 * 5);
    net.destroy();
  });

  it("resolves through a plain network's hierarchy, data(graph, { modules }), with LOD off", async () => {
    const graph = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    const modules = [
      { id: 0, path: [1, 1, 1] },
      { id: 1, path: [1, 2, 1] },
      { id: 2, path: [2, 1] },
    ];
    const net = await engine(host());
    net.style({ nodeRadius: 10, nodeFill: { by: "module", color: colorOf } }).data(graph, { modules });
    net.layout({ backend: "positions", positions: new Float32Array([40, 100, 100, 100, 160, 100]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    const img = await frame(net);
    expect(near(rgbaAt(img, 40, 100).slice(0, 3), RGB["#ff7f0e"]!)).toBe(true);
    expect(near(rgbaAt(img, 100, 100).slice(0, 3), RGB["#9467bd"]!)).toBe(true);
    expect(near(rgbaAt(img, 160, 100).slice(0, 3), RGB["#1f77b4"]!)).toBe(true);
    net.destroy();
  });

  it("falls back to the default fill without a hierarchy, and for a module the palette has no colour for", async () => {
    const graph = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false });
    const net = await engine(host());
    net.style({ nodeRadius: 10, nodeFill: { by: "module", color: () => "#d62728" } }).data(graph);
    net.layout({ backend: "positions", positions: new Float32Array([60, 100, 140, 100]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    const img = await frame(net);
    expect(near(rgbaAt(img, 60, 100).slice(0, 3), RGB["#d62728"]!), "no hierarchy, yet the module colour").toBe(false);
    expect(rgbaAt(img, 60, 100)[3], "no node drawn").toBe(255);
    net.destroy();
  });
});

describe("hits and labels name their level in state mode (#494)", () => {
  it("hits, selection hits and label info carry level (and a physical node its physical id)", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    const infos: { id: number; level?: string }[] = [];
    net.style({ nodeRadius: 8 }).stateNetwork(graph, { modules, view: "physical" });
    place(net);
    net.interactive({ selectable: true });
    net.labels({ labelOf: (id, info) => (infos.push({ id, level: info.level }), `${id}`) });
    const hit = net.pick(POS[2]!, POS[3]!);
    expect(hit?.id).toBe(1);
    expect((hit?.datum as NetworkHit).level).toBe("physical");
    expect((hit?.datum as NetworkHit).physical).toBe(1);
    expect(infos.length).toBeGreaterThan(0);
    expect(infos.every((i) => i.level === "physical")).toBe(true);

    infos.length = 0;
    net.view("state");
    net.labels({ labelOf: (id, info) => (infos.push({ id, level: info.level }), `${id}`) });
    expect(infos.length).toBeGreaterThan(0);
    expect(infos.every((i) => i.level === "state")).toBe(true);
    const [x, y] = statePos(net, 3);
    expect((net.pick(x, y)?.datum as NetworkHit).level).toBe("state");

    // A plain network's hits carry no level.
    net.data(buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false }));
    net.layout({ backend: "positions", positions: new Float32Array([60, 100, 140, 100]) });
    expect((net.pick(60, 100)?.datum as NetworkHit).level).toBeUndefined();
    net.destroy();
  });
});

// ── #494 review: link units in the both view, LOD across views, module aggregates ─────────────────────────

/** Two physical nodes 120 apart on one row, one state node each, one directed link 0 → 1: a horizontal link. */
function pairFixture() {
  const graph = buildStateGraph({ stateCount: 2, stateToPhysical: [0, 1], source: [0], target: [1], nodeFlow: [1, 1], directed: true });
  return { graph, positions: new Float32Array([40, 100, 160, 100]) };
}
const LINK_RGB: [number, number, number] = [0, 200, 0];
const isLink = (c: readonly number[]): boolean => (c[1] ?? 0) > 120 && (c[0] ?? 0) < 90 && (c[2] ?? 0) < 90;
/** A view at zoom `k` that keeps world point (100, 100), the link's middle, at the canvas centre. */
const centred = (k: number) => ({ k, x: W / 2 - 100 * k, y: H / 2 - 100 * k });

describe("the both view draws its links in the app's sizeMode (#494 review, 1; #509)", () => {
  for (const linkStyle of ["line", "half-arrow"] as const) {
    it(`${linkStyle}: px-wide links and a tip on the px-sized state node's boundary at two zoom levels (sizeMode "screen")`, async () => {
      const { graph, positions } = pairFixture();
      const net = await engine(host());
      // Transparent dots, so the tip the dot would cover stays visible.
      net
        .style({ sizeMode: "screen", nodeRadius: 8, linkStyle, linkWidth: 6, arrowSize: 6, linkStroke: `rgb(${LINK_RGB.join(",")})`, directed: true, nodeFill: "rgba(0,0,0,0)" })
        .stateNetwork(graph, { view: "both" });
      net.layout({ backend: "positions", positions });
      // The target state node: alone in its physical node, so at its centre, and 8 px in radius at every zoom (#509).
      const [tx, ty] = statePos(net, 1);
      const r = 8;
      // k = 1.5, not 2: the 8 px tip of the target at world x = 160 must stay on the 200 px canvas.
      for (const k of [0.5, 1.5]) {
        const t = centred(k);
        net.setTransform(t);
        const img = await frame(net);
        // Width: the green run across the link's middle column (between the containers), in px.
        if (linkStyle === "line") {
          let rows = 0;
          for (let y = 0; y < H; y++) if (isLink(rgbaAt(img, W / 2, y))) rows++;
          expect(Math.abs(rows - 6), `k=${k}: link drawn ${rows} px wide, the app asked for 6 px`).toBeLessThanOrEqual(1.5);
        }
        // Tip: the rightmost link pixel on the target's row sits on the state node's boundary, r px short of its centre.
        const cx = tx * k + t.x;
        const cy = Math.round(ty * k + t.y);
        // The tip is a sharp point (a line also runs on to the transparent dot's centre), so it is read off the
        // head's slanted edge, clear of the line's band: on a row d px off the centre line the edge is at
        // tip − slope·d (a line's head: 2·size long, ±size wide; a half-arrow's: tipLength long, width + 2√width
        // wide), so each such row estimates the tip; their median is the drawn tip.
        const head = linkStyle === "line" ? { slope: 2, rows: [4, 5] } : { slope: Math.min((120 * k - 2 * r) / 3, 10 * Math.cbrt(6)) / (6 + 2 * Math.sqrt(6)), rows: [6, 7, 8] };
        const estimates: number[] = [];
        for (const d of head.rows) {
          for (const y of [cy - d, cy + d]) {
            let edge = -1;
            for (let x = 0; x < W; x++) if (isLink(rgbaAt(img, x, y))) edge = x;
            if (edge >= 0) estimates.push(edge + head.slope * d);
          }
        }
        estimates.sort((a, b) => a - b);
        const tip = estimates[Math.floor(estimates.length / 2)] ?? NaN;
        // Within 2 px (anti-aliasing reads the edge a little short); a setback in the wrong units is off by r·|k − 1| ≥ 4 px.
        expect(Math.abs(tip - (cx - r)), `k=${k}: tip at ${tip.toFixed(1)} (${estimates.map((e) => e.toFixed(1)).join(" ")}), the boundary at ${(cx - r).toFixed(1)}`).toBeLessThanOrEqual(2);
      }
      net.destroy();
    });
  }

  it("the vector twins agree: px-sized heads set back by the world radius at any zoom (WebGL export, SVG scene)", async () => {
    const { graph, positions } = pairFixture();
    /** Each path's first two points: an arrowhead's tip, then a base corner (2·size back, size aside: size·√5 away). */
    const headsOf = (svg: string): { tip: number; side: number }[] =>
      [...svg.matchAll(/<path d="M\s*([-\d.e]+)[ ,]\s*([-\d.e]+)\s*L\s*([-\d.e]+)[ ,]\s*([-\d.e]+)/g)]
        .map((m) => ({ tip: Number(m[1]), side: Math.hypot(Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])) }))
        .filter((h) => Number.isFinite(h.tip));
    const tips: Record<string, number[]> = {};
    for (const backend of ["webgl", "svg"] as const) {
      const net = network(host(), { width: W, height: H, backend });
      await net.whenReady();
      net.style({ sizeMode: "screen", linkStyle: "line", linkWidth: 6, arrowSize: 6, directed: true }).stateNetwork(graph, { view: "both" });
      net.layout({ backend: "positions", positions });
      const [tx, ty] = statePos(net, 1);
      const r = circlesOf(net.toSVG()).find((c) => !c.stroked && Math.abs(c.cx - tx) < 0.01 && Math.abs(c.cy - ty) < 0.01)?.r ?? NaN;
      expect(r, `${backend}: the target dot`).toBeGreaterThan(0);
      for (const k of [0.5, 2]) {
        net.setTransform(centred(k));
        net.syncScreenGeometry(); // re-bakes the vector path's screen-mode arrows at k
        const svg = net.toSVG();
        // An arrowhead's path starts at its tip: in world units r short of the target, whatever k.
        const head = headsOf(svg).find((h) => Math.abs(h.tip - (tx - r)) < 0.5);
        expect(head, `${backend} k=${k}: no arrow tip at the dot's boundary (${(tx - r).toFixed(2)})`).toBeDefined();
        // The head is 6 px in size whatever the zoom: 6·√5 / k world units from the tip to a base corner.
        expect(head?.side ?? NaN, `${backend} k=${k}: the head is not px-sized`).toBeCloseTo((6 * Math.sqrt(5)) / k, 1);
        (tips[backend] ??= []).push(head?.tip ?? NaN);
      }
      net.destroy();
    }
    expect(tips["webgl"]).toEqual(tips["svg"]?.map((x) => expect.closeTo(x, 2)));
  });
});

describe("the app's lod() holds across state-network views (#494 review, 2)", () => {
  it("state(lod) → both → lod(change) → state draws the changed LOD; physical (in full, with its pies) → state likewise", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.stateNetwork(graph, { modules, view: "state" });
    place(net);
    net.lod({ modules });
    expect(net.lodSource).toBe("modules");
    net.view("both");
    expect(net.lodSource, "the both view draws in full").toBe("none");
    expect(circlesOf(net.toSVG()).filter((c) => c.stroked).length, "the both view's containers").toBe(P);
    net.lod({ source: "spatial" }); // asked for in the both view: kept, not drawn there
    expect(net.lodSource).toBe("none");
    expect(circlesOf(net.toSVG()).filter((c) => c.stroked).length, "lod() in the both view dropped its containers").toBe(P);
    net.view("state");
    expect(net.lodSource, "the state view came back without the changed LOD").toBe("spatial");

    // The physical view draws in full, every pie with it, until pies are LOD-aware (#174); it keeps the request.
    net.view("physical");
    expect(net.lodSource, "the physical view took the app's spatial LOD").toBe("none");
    expect(net.toSVG(), "the app's LOD hid the physical view's pies").toMatch(/<path[^>]*fill="rgba?\(/);
    net.lod({ modules });
    expect(net.lodSource).toBe("none");
    expect(net.toSVG(), "lod() in the physical view hid its pies").toMatch(/<path[^>]*fill="rgba?\(/);
    net.view("state");
    expect(net.lodSource, "the state view came back without the LOD asked for in the physical view").toBe("modules");
    net.lod(false);
    net.view("both");
    net.view("state");
    expect(net.lodSource, "lod(false) holds across views too").toBe("none");
    net.destroy();
  });
});

/** Every circle fill of an export, as `r,g,b`. */
function circleFills(svg: string): string[] {
  const out: string[] = [];
  for (const m of svg.matchAll(/<circle[^>]*fill="([^"]+)"/g)) {
    const css = m[1] ?? "";
    const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(css);
    const hex = /^#([0-9a-f]{6})$/i.exec(css);
    if (rgb) out.push(`${rgb[1]},${rgb[2]},${rgb[3]}`);
    else if (hex) {
      const v = parseInt(hex[1] ?? "0", 16);
      out.push(`${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`);
    }
  }
  return out;
}
const fills = (...css: string[]) => new Set(css.map((c) => (RGB[c] ?? [0, 0, 0]).join(",")));

describe("module LOD aggregates take their module's colour under nodeFill { by: 'module' } (#494 review, 3)", () => {
  // Module [1] holds [1,1] (orange) and [1,2] (purple) and no node of its own: as an aggregate it is red, its
  // own colour, where its members' mean would be neither. [2] is blue; the root has no palette colour. Its two
  // submodules sit a few world units apart and [2] far away, so with screen-sized glyphs the cut draws [1]
  // collapsed over a wide range of zooms.
  const zooms = Array.from({ length: 30 }, (_, i) => 0.01 * Math.pow(1.25, i)); // 0.01 … 6.5
  const sweep = (net: Network, cx: number, cy: number): Set<string> => {
    const seen = new Set<string>();
    for (const k of zooms) {
      net.setTransform({ k, x: W / 2 - cx * k, y: H / 2 - cy * k });
      for (const f of circleFills(net.toSVG())) seen.add(f);
    }
    return seen;
  };

  it("a plain network's module tree, data(graph, { modules }): an aggregate takes color(its path)", async () => {
    const graph = buildGraph({ nodeCount: 5, source: [0, 1, 3], target: [1, 2, 4], directed: false });
    const modules = [
      { id: 0, path: [1, 1, 1] },
      { id: 1, path: [1, 1, 2] },
      { id: 2, path: [1, 2, 1] },
      { id: 3, path: [2, 1] },
      { id: 4, path: [2, 2] },
    ];
    const calls: string[] = [];
    const color = (path: readonly number[]) => (calls.push(path.join(":")), colorOf(path));
    const net = await engine(host());
    net.style({ nodeRadius: 6, sizeMode: "screen", nodeFill: { by: "module", color } }).data(graph, { modules });
    net.layout({ backend: "positions", positions: new Float32Array([40, 100, 41, 100, 44, 100, 160, 100, 162, 100]) });
    net.lod({ declutter: false });
    expect(net.lodSource).toBe("modules");
    const seen = sweep(net, 100, 100);
    expect(seen.has(RGB["#d62728"]!.join(",")), `module [1] never drew in its own colour (red): ${[...seen].join(" | ")} calls ${calls.join(" ")}`).toBe(true);
    const allowed = fills("#d62728", "#1f77b4", "#ff7f0e", "#9467bd");
    const other = [...seen].filter((f) => !allowed.has(f));
    // The root (no palette colour) takes the default fill; nothing takes a members' mean.
    expect(other.length, `aggregate fills that are no module colour: ${other.join(" | ")}`).toBeLessThanOrEqual(1);
    expect(new Set(calls).size, "color asked more than once for a module").toBe(calls.length);
    net.destroy();
  });

  it("the state view's module LOD likewise; a spatial cell (no module) keeps its members' mean", async () => {
    // Physical 0 holds module [1]'s state nodes (in [1,1] and [1,2]) on a tight rosette; physical 1 holds [2]'s.
    const graph = buildStateGraph({ stateCount: 4, stateToPhysical: [0, 0, 1, 1], source: [0, 2], target: [2, 3], nodeFlow: [1, 1, 1, 1], directed: false });
    const modules: ModulePathNode[] = [
      { id: 0, path: [1, 1, 1] },
      { id: 1, path: [1, 2, 1] },
      { id: 2, path: [2, 1] },
      { id: 3, path: [2, 2] },
    ];
    const calls: string[] = [];
    const color = (path: readonly number[]) => (calls.push(path.join(":")), colorOf(path));
    const net = await engine(host());
    net.style({ nodeRadius: 6, sizeMode: "screen", nodeFill: { by: "module", color } }).stateNetwork(graph, { modules, view: "state" });
    net.layout({ backend: "positions", positions: new Float32Array([39, 100, 41, 100, 159, 100, 161, 100]) }); // the state view's own
    net.lod({ modules, declutter: false });
    expect(net.lodSource).toBe("modules");
    const seen = sweep(net, 100, 100);
    expect(seen.has(RGB["#d62728"]!.join(",")), `module [1] never drew in its own colour (red): ${[...seen].join(" | ")}`).toBe(true);
    const allowed = fills("#d62728", "#1f77b4", "#ff7f0e", "#9467bd");
    expect([...seen].filter((f) => !allowed.has(f)).length, "an aggregate took a members' mean").toBeLessThanOrEqual(1);
    expect(new Set(calls).size, "color asked more than once for a module, across levels and pies").toBe(calls.length);

    // A spatial tree's cells are regions, not modules: the cell holding every state node takes their mean.
    net.lod({ source: "spatial", declutter: false });
    expect(net.lodSource).toBe("spatial");
    const spatial = sweep(net, 100, 100);
    expect([...spatial].some((f) => !allowed.has(f)), "a spatial cell took a module colour, not its members' mean").toBe(true);
    net.destroy();
  });
});

describe("the app's module palette reaches the pies whatever the node fill: style({ moduleColor }) (#494 review, 4)", () => {
  /** The pie layer's data on each emit that reaches the WebGL backend, and whether it was updated in place. */
  function pieEmits() {
    const emits: { inPlace: boolean; centers: Float32Array; radii: Float32Array; angles: Float32Array; colors: Uint8Array }[] = [];
    const record = (inPlace: boolean) => (layer: InstancedLayer) => {
      if (layer.primitive === "pie") emits.push({ inPlace, centers: layer.pie.centers, radii: layer.pie.radii, angles: layer.pie.angles, colors: layer.pie.colors });
    };
    const set = WebGLBackend.prototype.setInstancedLayer;
    const update = WebGLBackend.prototype.updateInstancedLayer;
    vi.spyOn(WebGLBackend.prototype, "setInstancedLayer").mockImplementation(function (this: WebGLBackend, layer: InstancedLayer) {
      record(false)(layer);
      set.call(this, layer);
    });
    vi.spyOn(WebGLBackend.prototype, "updateInstancedLayer").mockImplementation(function (this: WebGLBackend, layer: InstancedLayer) {
      record(true)(layer);
      update.call(this, layer);
    });
    return emits;
  }
  const wedgeColours = (img: { width: number; data: Uint8Array }) => [rgbaAt(img, POS[0]! + 6, POS[1]! + 3).slice(0, 3), rgbaAt(img, POS[0]! - 6, POS[1]! - 3).slice(0, 3)];

  it("flow-filled nodes: the wedges take the app's module colours; a palette style() recolours them, colours alone", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    const calls: string[] = [];
    const first = (path: readonly number[]) => (calls.push(path.join(":")), colorOf(path));
    const flow = { by: "flow" as const, scale: () => "#00c000" };
    net.style({ nodeRadius: 12, nodeFill: flow, moduleColor: first }).stateNetwork(graph, { modules, view: "physical" });
    place(net);
    let img = await frame(net);
    expect(near(rgbaAt(img, POS[2]!, POS[3]!).slice(0, 3), [0, 192, 0]), "the discs keep the app's flow fill").toBe(true);
    let wedges = wedgeColours(img);
    expect(wedges.some((c) => near(c, RGB["#d62728"]!)) && wedges.some((c) => near(c, RGB["#1f77b4"]!)), `pie wedges ${wedges}`).toBe(true);
    expect(new Set(calls).size, "a module colour asked twice").toBe(calls.length);

    // A palette change (tone / hue) through style() alone: the same network, the same geometry.
    const emits = pieEmits();
    const second = (path: readonly number[]) => ({ "1": "#9467bd", "2": "#ff7f0e" })[path.join(":")];
    const before = emits.length;
    net.style({ moduleColor: second });
    img = await frame(net);
    wedges = wedgeColours(img);
    expect(wedges.some((c) => near(c, RGB["#9467bd"]!)) && wedges.some((c) => near(c, RGB["#ff7f0e"]!)), `recoloured wedges ${wedges}`).toBe(true);
    expect(near(rgbaAt(img, POS[2]!, POS[3]!).slice(0, 3), [0, 192, 0]), "the discs still take the flow fill").toBe(true);
    // The pie layer was updated in place with its geometry columns unchanged (the SAME arrays, whose upload the
    // WebGL pie skips) and new colours.
    const after = emits.slice(before);
    expect(after.length, "the palette change never reached the pie layer").toBeGreaterThan(0);
    const prev = after.length > 1 ? after[0] : undefined;
    const last = after[after.length - 1];
    expect(after.every((e) => e.inPlace), "the pie layer was recreated").toBe(true);
    if (prev && last) {
      expect(last.centers).toBe(prev.centers);
      expect(last.radii).toBe(prev.radii);
      expect(last.angles).toBe(prev.angles);
    }
    net.destroy();
  });

  it("the pie emit hands back unchanged geometry: a palette change keeps the centres, radii and angles arrays", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.style({ nodeRadius: 12, nodeFill: "#00c000", moduleColor: colorOf }).stateNetwork(graph, { modules, view: "physical" });
    place(net);
    const emits = pieEmits();
    net.style({ nodeRadius: 12 }); // a restyle that changes nothing the pie draws
    net.toPNG();
    net.style({ moduleColor: (path) => ({ "1": "#9467bd", "2": "#ff7f0e" })[path.join(":")] });
    net.toPNG();
    expect(emits.length).toBeGreaterThanOrEqual(2);
    const [a, b] = [emits[emits.length - 2], emits[emits.length - 1]];
    expect(b?.centers).toBe(a?.centers);
    expect(b?.radii).toBe(a?.radii);
    expect(b?.angles).toBe(a?.angles);
    expect(b?.colors, "the colours did not change").not.toBe(a?.colors);
    net.destroy();
  });

  it("flow-filled nodes: the both view's containers take moduleColor, by the physical disc's rule", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.style({ nodeFill: { by: "flow", scale: () => "#00c000" }, moduleColor: colorOf }).stateNetwork(graph, { modules, view: "both" });
    place(net);
    /** The fill of the stroked (container) circle centred on physical `p`, as `r,g,b`. */
    const containerFill = (p: number): string | undefined => {
      for (const m of net.toSVG().matchAll(/<circle([^>]*)>/g)) {
        const a = m[1] ?? "";
        const num = (k: string) => Number(new RegExp(`\\b${k}="([^"]+)"`).exec(a)?.[1] ?? NaN);
        if (!(num("stroke-width") > 0) || Math.abs(num("cx") - POS[2 * p]!) > 0.01 || Math.abs(num("cy") - POS[2 * p + 1]!) > 0.01) continue;
        const rgb = /fill="rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(a);
        return rgb ? `${rgb[1]},${rgb[2]},${rgb[3]}` : /fill="([^"]+)"/.exec(a)?.[1];
      }
      return undefined;
    };
    // Physical 1 holds module [1] alone (red), physical 2 module [2] (blue), physical 0 a pie whose first wedge is [1].
    expect(containerFill(1)).toBe(RGB["#d62728"]!.join(","));
    expect(containerFill(2)).toBe(RGB["#1f77b4"]!.join(","));
    expect(containerFill(0)).toBe(RGB["#d62728"]!.join(","));
    // The state dots keep the flow fill.
    const img = await frame(net);
    const [x, y] = statePos(net, 3);
    expect(near(rgbaAt(img, x, y).slice(0, 3), [0, 192, 0]), `state dot ${rgbaAt(img, x, y)}`).toBe(true);
    net.destroy();
  });

  it("a { by: 'module' } fill without its own colour, and a state network with no nodeFill, take moduleColor", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.style({ nodeRadius: 12, moduleColor: colorOf }).stateNetwork(graph, { modules, view: "state" });
    place(net);
    const want: Record<number, string> = { 0: "#ff7f0e", 1: "#1f77b4", 4: "#9467bd" };
    const check = async (label: string) => {
      const img = await frame(net);
      for (const [s, hex] of Object.entries(want)) {
        const [x, y] = statePos(net, Number(s));
        expect(near(rgbaAt(img, x, y).slice(0, 3), RGB[hex]!), `${label}: state ${s} is ${rgbaAt(img, x, y)}, want ${hex}`).toBe(true);
      }
    };
    await check("no nodeFill");
    net.style({ nodeFill: { by: "module" } });
    await check("{ by: 'module' }");
    net.destroy();
  });
});
