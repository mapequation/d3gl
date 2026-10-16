import { describe, it, expect, vi, afterEach } from "vitest";
import { network, type Network, type NetworkHit } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import { buildGraph } from "../graph.js";
import type { ModulePathNode } from "../module-colors.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { InstancedHighlight } from "../../core/backend.js";
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

/** Place the physical nodes and frame world == screen (k = 1). */
function place(net: Network): void {
  net.layout({ backend: "positions", positions: POS });
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

const statePos = (g: ReturnType<typeof fixture>["graph"], s: number): [number, number] => [g.state.positions[2 * s]!, g.state.positions[2 * s + 1]!];

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
    const [x, y] = statePos(graph, 3);
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
      const [x, y] = statePos(graph, s);
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
    const [sx, sy] = statePos(graph, 2);
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
    const [s2x, s2y] = statePos(graph, 2);
    const [s3x, s3y] = statePos(graph, 3);
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
    const s0 = [statePos(graph, 2), statePos(graph, 4)];
    const other = statePos(graph, 3);
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
    for (const [k, s] of [2, 4].entries()) {
      const [sx, sy] = statePos(graph, s);
      expect(sx - s0[k]![0], `state ${s} did not follow its container`).toBeCloseTo(20, 3);
      expect(sy - s0[k]![1]).toBeCloseTo(12, 3);
    }
    expect(statePos(graph, 3), "another physical node's state moved").toEqual(other);
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
          const [x, y] = statePos(graph, Number(s));
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
    const [x, y] = statePos(graph, 3);
    expect((net.pick(x, y)?.datum as NetworkHit).level).toBe("state");

    // A plain network's hits carry no level.
    net.data(buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false }));
    net.layout({ backend: "positions", positions: new Float32Array([60, 100, 140, 100]) });
    expect((net.pick(60, 100)?.datum as NetworkHit).level).toBeUndefined();
    net.destroy();
  });
});
