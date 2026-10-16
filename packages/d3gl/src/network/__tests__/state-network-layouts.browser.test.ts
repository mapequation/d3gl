import { describe, it, expect, afterEach } from "vitest";
import { network, type Network, type NetworkHit } from "../network.js";
import { buildStateGraph, type StateNetworkGraph } from "../state-graph.js";
import type { ModulePathNode } from "../module-colors.js";
import { decodeImage } from "../../map/__tests__/backend-equivalence-harness.js";

/**
 * A layout per state-network view (#495), through the public API:
 *  - each view keeps its positions across switches; the physical and both views share the physical layout, the
 *    both view keeps each state dot's place in its container (a drag there included), the state view its own;
 *  - a view never laid out is laid out when first shown, with the app's last options;
 *  - the state view is the plain network over the state graph and its modules: `data(state, { modules })`;
 *  - a drag reheats the layout of the view it is in, after any view switch, with one coordinate scale (#401),
 *    on the force, worker and GPU backends; a both-view container drag reheats the physical layout;
 *  - a new `stateNetwork()` keeps the app's `lod()` request;
 *  - the both view's container rings are a thin px ring in a darker shade of the container's fill, at any zoom.
 */

const W = 400;
const H = 300;

/** A ring of `P` physical nodes with chords, two state nodes each, in two top modules of two sub-modules. */
function fixture(P = 24): { graph: StateNetworkGraph; modules: ModulePathNode[] } {
  const stateToPhysical: number[] = [];
  for (let p = 0; p < P; p++) stateToPhysical.push(p, p);
  const source: number[] = [];
  const target: number[] = [];
  for (let p = 0; p < P; p++) {
    source.push(2 * p, 2 * p + 1);
    target.push(2 * ((p + 1) % P) + 1, 2 * ((p + 5) % P));
  }
  const graph = buildStateGraph({ stateCount: 2 * P, stateToPhysical, source, target, directed: true });
  const rank = new Map<string, number>();
  const modules: ModulePathNode[] = [];
  for (let s = 0; s < 2 * P; s++) {
    const module = [stateToPhysical[s]! < P / 2 ? 1 : 2, (s % 2) + 1];
    const key = module.join(":");
    const r = (rank.get(key) ?? 0) + 1;
    rank.set(key, r);
    modules.push({ id: s, path: [...module, r] });
  }
  return { graph, modules };
}

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

const copy = (net: Network): Float32Array => Float32Array.from(net.positions ?? []);
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await nextFrame();
};

/** Frame `positions` in the view (k, x, y) and return it, so a test can point at a node. */
function frameAll(net: Network, positions: Float32Array): { k: number; x: number; y: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    minX = Math.min(minX, positions[i]!);
    maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!);
    maxY = Math.max(maxY, positions[i + 1]!);
  }
  const k = 0.8 * Math.min(W / Math.max(maxX - minX, 1), H / Math.max(maxY - minY, 1));
  const t = { k, x: W / 2 - (k * (minX + maxX)) / 2, y: H / 2 - (k * (minY + maxY)) / 2 };
  net.setTransform(t);
  return t;
}

/** Press on screen point (x, y), move by (dx, dy) over `steps` frames, release. */
async function drag(h: HTMLElement, x: number, y: number, dx: number, dy: number, steps = 6): Promise<void> {
  const r = h.getBoundingClientRect();
  const ev = (type: string, px: number, py: number): boolean =>
    h.dispatchEvent(new PointerEvent(type, { clientX: r.left + px, clientY: r.top + py, bubbles: true, button: 0, pointerId: 1 }));
  ev("pointerdown", x, y);
  for (let i = 1; i <= steps; i++) {
    ev("pointermove", x + (dx * i) / steps, y + (dy * i) / steps);
    await nextFrame();
  }
  ev("pointerup", x + dx, y + dy);
}

/** The diagonal of the box of `positions`, skipping the node ids in `skip`. */
function spread(positions: Float32Array, skip: ReadonlySet<number> = new Set()): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length / 2; i++) {
    if (skip.has(i)) continue;
    minX = Math.min(minX, positions[2 * i]!);
    maxX = Math.max(maxX, positions[2 * i]!);
    minY = Math.min(minY, positions[2 * i + 1]!);
    maxY = Math.max(maxY, positions[2 * i + 1]!);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/** The largest displacement between two position snapshots, skipping `skip`. */
function maxMove(a: Float32Array, b: Float32Array, skip: ReadonlySet<number> = new Set()): number {
  let m = 0;
  for (let i = 0; i < a.length / 2; i++) if (!skip.has(i)) m = Math.max(m, Math.hypot(a[2 * i]! - b[2 * i]!, a[2 * i + 1]! - b[2 * i + 1]!));
  return m;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("each view keeps its layout across switches (#495, 9)", () => {
  it("physical, state and both keep their positions; a both-view drag keeps a dot's place in its container", async () => {
    const { graph, modules } = fixture();
    const h = host();
    const net = await engine(h);
    net.stateNetwork(graph, { modules, view: "physical" }).layout({ backend: "force", iterations: 60 });
    net.interactive({ draggable: true });
    const physical = copy(net);

    net.view("state"); // laid out on show, with the app's last options
    const state = copy(net);
    expect(maxMove(state, Float32Array.from(graph.state.positions)), "the state view draws the state graph's own layout").toBe(0);
    expect(maxMove(physical, graph.physical.positions), "the state view's layout moved the physical nodes").toBe(0);

    net.view("both");
    expect(maxMove(physical, graph.physical.positions)).toBe(0);
    // Drag state dot 0 inside its container: the physical layout stays, the dot keeps its new place.
    const t = frameAll(net, net.positions!);
    const before = copy(net);
    await drag(h, t.k * before[0]! + t.x, t.k * before[1]! + t.y, 12, 8);
    const both = copy(net);
    expect(Math.hypot(both[0]! - before[0]!, both[1]! - before[1]!), "the dot did not move").toBeGreaterThan(1);
    expect(maxMove(before, both, new Set([0])), "a dot drag moved other dots").toBe(0);
    expect(maxMove(physical, graph.physical.positions), "a dot drag moved the physical layout").toBe(0);

    net.view("state");
    expect(maxMove(state, copy(net)), "the state view's positions were re-derived").toBe(0);
    net.view("both");
    expect(maxMove(both, copy(net)), "the both view lost the dragged dot's place").toBeLessThan(1e-4);
    net.view("physical");
    expect(maxMove(physical, copy(net))).toBe(0);
    net.destroy();
  });

  it("the both view's dots keep their places as the physical layout runs again", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.stateNetwork(graph, { modules, view: "both" }).layout({ backend: "force", iterations: 40 });
    const place = (positions: Float32Array, s: number): [number, number] => {
      const p = graph.stateToPhysical[s]!;
      return [positions[2 * s]! - graph.physical.positions[2 * p]!, positions[2 * s + 1]! - graph.physical.positions[2 * p + 1]!];
    };
    const a = copy(net);
    const offsets = Array.from({ length: 6 }, (_, s) => place(a, s));
    net.layout({ backend: "force", iterations: 40, warm: true });
    const b = copy(net);
    expect(maxMove(a, b), "the warm re-layout moved nothing").toBeGreaterThan(0);
    for (let s = 0; s < 6; s++) {
      const [x0, y0] = offsets[s]!;
      const [x1, y1] = place(b, s);
      // The same direction from the container's centre; the radius follows the container's size.
      if (Math.hypot(x0, y0) > 1e-6) expect(Math.abs(x1 * y0 - y1 * x0) / Math.hypot(x0, y0) ** 2, `dot ${s} turned`).toBeLessThan(1e-3);
    }
    net.destroy();
  });
});

describe("a view never laid out is laid out on first show (#495, 8)", () => {
  it("the state view starts from the rosette and runs the app's last options; whenSettled() follows it", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.stateNetwork(graph, { modules, view: "physical" }).layout({ backend: "worker", iterations: 30 });
    await net.whenSettled();
    net.view("state");
    expect(["shared", "copy"], "the last options' backend").toContain(net.layoutTransport);
    await net.whenSettled();
    expect(Array.from(net.positions!).every(Number.isFinite)).toBe(true);
    expect(spread(net.positions!)).toBeGreaterThan(0);
    // Shown again, it is not laid out again.
    const settled = copy(net);
    net.view("physical");
    net.view("state");
    expect(net.layoutTransport).not.toBe("none"); // its settled run, kept alive for a drag
    expect(maxMove(settled, copy(net))).toBe(0);
    net.destroy();
  });

  it("supplied positions are the active view's graph's; a view never laid out by them starts from the other's", async () => {
    const { graph, modules } = fixture(4);
    const net = await engine(host());
    net.stateNetwork(graph, { modules, view: "state" });
    expect(() => net.layout({ backend: "positions", positions: new Float32Array(8) }), "physical positions in the state view").toThrow(/state/);
    net.layout({ backend: "positions", positions: Float32Array.from({ length: 16 }, (_, i) => 10 * i) });
    net.view("physical");
    // Each physical node at its state nodes' centroid; the supplied positions computed nothing more.
    for (let p = 0; p < 4; p++) {
      expect(graph.physical.positions[2 * p]).toBeCloseTo((10 * (4 * p) + 10 * (4 * p + 2)) / 2, 4);
      expect(graph.physical.positions[2 * p + 1]).toBeCloseTo((10 * (4 * p + 1) + 10 * (4 * p + 3)) / 2, 4);
    }
    net.destroy();
  });

  it("a run a switch interrupted goes on, warm, when its view is shown again", async () => {
    const { graph, modules } = fixture();
    const net = await engine(host());
    net.stateNetwork(graph, { modules, view: "physical" }).layout({ backend: "worker", iterations: 300 });
    net.view("state"); // the physical run had not settled: it stops
    await net.whenSettled();
    net.view("physical");
    expect(["shared", "copy"], "the interrupted run goes on").toContain(net.layoutTransport);
    await net.whenSettled();
    expect(spread(graph.physical.positions)).toBeGreaterThan(0);
    net.destroy();
  });
});

describe("the state view is data(state, { modules }) (#495, 7)", () => {
  it("draws, cuts and lays out exactly as the plain network over the same graph and modules", async () => {
    const a = fixture();
    const b = fixture(); // its own graph objects
    const state = await engine(host());
    const plain = await engine(host());
    const style = { nodeRadius: 4, nodeFill: "#888888", linkStroke: "#999999" } as const;
    state.style(style).stateNetwork(a.graph, { modules: a.modules, view: "state" });
    plain.style(style).data(b.graph.state, { modules: b.modules });
    const positions = Float32Array.from({ length: 2 * a.graph.state.nodeCount }, (_, i) => 50 + ((i * 37) % 300));
    for (const net of [state, plain]) {
      net.layout({ backend: "positions", positions });
      net.layout({ backend: "force", nested: true, iterations: 40 });
      net.lod({ declutter: false, moduleBoundary: { width: 1 } });
      net.setTransform({ k: 1, x: 0, y: 0 });
    }
    expect(state.lodSource).toBe("modules");
    expect(maxMove(Float32Array.from(state.positions!), Float32Array.from(plain.positions!)), "the nested layouts differ").toBeLessThan(1e-3);
    expect(state.toSVG(), "the state view draws what the plain network draws").toBe(plain.toSVG());
    // hit.path: a state node's module path, as the plain network reports it.
    const x = state.positions![0]!, y = state.positions![1]!;
    for (const net of [state, plain]) net.lod(false);
    const hit = state.pick(x, y)?.datum as NetworkHit;
    expect(hit.path).toEqual((plain.pick(x, y)?.datum as NetworkHit).path);
    expect(hit.level).toBe("state");
    state.destroy();
    plain.destroy();
  });

  it("a new stateNetwork() keeps the app's lod() request; the new network's modules take an explicit alias's place", async () => {
    const a = fixture();
    const net = await engine(host());
    net.stateNetwork(a.graph, { modules: a.modules, view: "state" }).layout({ backend: "force", iterations: 20 });
    net.lod({ modules: a.modules, declutter: false });
    expect(net.lodSource).toBe("modules");
    const b = fixture(30);
    net.stateNetwork(b.graph, { modules: b.modules, view: "state" }).layout({ backend: "force", iterations: 20 });
    expect(net.lodSource, "the request was dropped").toBe("modules");
    net.destroy();
  });
});

describe("a drag reheats the view's own layout, after any switch, at one scale (#495, 4; #401)", () => {
  for (const backend of ["force", "worker", "gpu"] as const) {
    it(`${backend}: physical → state → both → physical, then a drag reflows the physical layout without a jump in scale`, async () => {
      const { graph, modules } = fixture();
      const h = host();
      const net = await engine(h);
      net.stateNetwork(graph, { modules, view: "physical" }).layout({ backend, iterations: 60 });
      await net.whenSettled();
      net.interactive({ draggable: true });
      net.view("state");
      await net.whenSettled();
      net.view("both");
      net.view("physical");
      const t = frameAll(net, graph.physical.positions);
      const before = Float32Array.from(graph.physical.positions);
      const scale = spread(before, new Set([0]));
      await drag(h, t.k * before[0]! + t.x, t.k * before[1]! + t.y, 40, 25, 10);
      await frames(20);
      await net.whenSettled();
      const after = Float32Array.from(graph.physical.positions);
      expect(maxMove(before, after, new Set([0])), "no other node moved: the drag did not reheat").toBeGreaterThan(0.01 * scale);
      const ratio = spread(after, new Set([0])) / scale;
      expect(ratio, "the layout changed scale").toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.4);
      net.destroy();
    }, 60_000);
  }

  it("a both-view container drag reheats the physical layout; every dot follows its container", async () => {
    const { graph, modules } = fixture();
    const h = host();
    const net = await engine(h);
    net.stateNetwork(graph, { modules, view: "both" }).layout({ backend: "force", iterations: 60 });
    net.interactive({ draggable: true });
    const t = frameAll(net, net.positions!);
    const before = Float32Array.from(graph.physical.positions);
    // Grab container 0 at its edge (no dot there): the top of its ring.
    const svg = net.toSVG();
    const ring = [...svg.matchAll(/<circle([^>]*)>/g)].map((m) => m[1] ?? "").find((c) => /stroke-width/.test(c) && Math.abs(Number(/\bcx="([^"]+)"/.exec(c)?.[1]) - before[0]!) < 1e-3);
    const r = Number(/\br="([^"]+)"/.exec(ring ?? "")?.[1]);
    expect(r).toBeGreaterThan(0);
    await drag(h, t.k * before[0]! + t.x, t.k * (before[1]! - 0.9 * r) + t.y, 30, 20, 8);
    await frames(70);
    const after = Float32Array.from(graph.physical.positions);
    expect(maxMove(before, after, new Set([0])), "the physical layout did not reheat").toBeGreaterThan(0.01 * spread(before));
    // Each dot sits where its container's place puts it: on its physical node for a lone dot, near it otherwise.
    const dots = net.positions!;
    for (let s = 0; s < graph.state.nodeCount; s++) {
      const p = graph.stateToPhysical[s]!;
      const d = Math.hypot(dots[2 * s]! - after[2 * p]!, dots[2 * s + 1]! - after[2 * p + 1]!);
      expect(d, `dot ${s} left its container`).toBeLessThan(spread(after));
    }
    net.destroy();
  });
});

describe("the both view's container rings (#495)", () => {
  it("a ring about 1 px wide, in a darker shade of the container's fill, at two zoom levels — and the same in the exports", async () => {
    const { graph } = fixture(2);
    for (const backend of ["webgl", "svg"] as const) {
      const net = await engine(host(), backend);
      // With zoom enabled a programmatic view change re-bakes the Scene's px geometry, as a gesture's end does (#309).
      net.enableZoom();
      net.style({ nodeFill: "#3366cc", nodeRadius: 2 }).stateNetwork(graph, { view: "both" });
      net.layout({ backend: "positions", positions: new Float32Array([100, 150, 300, 150]) });
      for (const k of [1, 3]) {
        net.setTransform({ k, x: (1 - k) * 100, y: (1 - k) * 150 }); // physical 0 stays at (100, 150) on screen
        const svg = net.toSVG();
        const ring = [...svg.matchAll(/<circle([^>]*)>/g)].map((m) => m[1] ?? "").find((c) => /stroke-width="[^"]+"/.test(c) && /\bcx="100"/.test(c));
        expect(ring, `${backend} k=${k}: no container ring exported`).toBeDefined();
        const num = (name: string): number => Number(new RegExp(`\\b${name}="([^"]+)"`).exec(ring ?? "")?.[1]);
        expect(num("stroke-width") * k, `${backend} k=${k}: ring px width`).toBeCloseTo(1, 2);
        const stroke = /\bstroke="([^"]+)"/.exec(ring ?? "")?.[1] ?? "";
        expect(stroke, `${backend}: the ring is not black`).not.toMatch(/^(#000000|#000|black|rgb\(0, ?0, ?0\))$/);
        if (backend !== "webgl") continue;
        // Pixels: walk up from the container's centre past its edge; the ring is the run of darker pixels.
        const img = await decodeImage(net.toPNG(), W, H);
        const outer = (num("r") + num("stroke-width") / 2) * k;
        let run = 0;
        let colour: number[] = [];
        for (let dy = Math.floor(outer) - 4; dy <= Math.ceil(outer) + 2; dy++) {
          const o = (Math.round(150 - dy) * img.width + 100) * 4;
          const px = [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, img.data[o + 3]!];
          if (px[3]! > 128 && px[2]! < 140 && px[2]! > 40) {
            run++;
            colour = px;
          }
        }
        expect(run, `webgl k=${k}: ring ${run} px wide`).toBeGreaterThanOrEqual(1);
        expect(run).toBeLessThanOrEqual(2);
        // #3366cc × 0.62 ≈ (32, 63, 126)
        expect(Math.abs(colour[2]! - 126), `ring colour ${colour}`).toBeLessThan(24);
      }
      net.destroy();
    }
  });
});
