/**
 * T4 spring parity (#350, spec §9 / §13): spring forces from identical positions, GPU vs a float64 CPU
 * sum, on rows far above the old 4096-neighbour cap.
 *
 * The bound is magnitude-scaled, per row and per component: a row summed at add depth D (its degree when
 * it is gathered directly, `HUB_CHUNK + chunks` when it is chunked) is within
 * `2 · D · ε · attraction · Σ_j |w · (p_j − p_i)|` of the exact sum, ε = FLT_EPSILON. That is the float32
 * error bound of a sequential sum, so it is tight enough to catch one dropped or doubled term (any term
 * is ≥ Σ / degree, far above D · ε · Σ) while never failing on rounding.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuSprings } from "../springs.js";
import { HUB_CHUNK, SPRING_CHUNK } from "../hub-chunks.js";
import { packPositionsTexture, readbackFloatFbo } from "../textures.js";
import type { LayoutGraph } from "../../force.js";

const EPS = 2 ** -23; // FLT_EPSILON
const ATTRACTION = 0.05;

/** Minimal seeded LCG PRNG — self-contained, no deps. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

/** Spring forces from `graph.positions`: one prepare + one draw into a cleared force texture, read back. */
function gpuSpringForces(device: Device, graph: LayoutGraph, attraction = ATTRACTION): Float32Array {
  const pos = packPositionsTexture(device, graph.positions);
  const force = device.createTexture({
    width: pos.width,
    height: pos.height,
    format: "rg32float",
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  const fbo = device.createFramebuffer({ width: pos.width, height: pos.height, colorAttachments: [force] });
  const springs = new GpuSprings(device, graph);
  springs.prepare(pos.texture, pos.width);
  const pass = device.beginRenderPass({ framebuffer: fbo, clearColor: [0, 0, 0, 0] });
  springs.draw(pass, pos.texture, { count: pos.count, width: pos.width, attraction });
  pass.end();
  device.submit();
  const out = readbackFloatFbo(device, force, pos.width, pos.count);
  springs.destroy();
  fbo.destroy();
  force.destroy();
  pos.texture.destroy();
  return out;
}

interface SpringReference {
  /** Exact (float64) spring force per node, interleaved x, y. */
  force: Float64Array;
  /** Per node and component, Σ_j |w · (p_j − p_i)| — the scale of the row's rounding error. */
  scale: Float64Array;
  /** Per node, the add depth of its row on the GPU. */
  depth: Float64Array;
}

/** Float64 spring sums over the float32 inputs the GPU sees (positions, weights, attraction). */
function referenceForces(graph: LayoutGraph, attraction = ATTRACTION): SpringReference {
  const n = graph.nodeCount;
  const p = graph.positions;
  const force = new Float64Array(n * 2);
  const scale = new Float64Array(n * 2);
  const degree = new Float64Array(n);
  const a = Math.fround(attraction);
  for (let e = 0; e < graph.edgeCount; e++) {
    const s = graph.source[e] ?? 0;
    const t = graph.target[e] ?? 0;
    const w = graph.springWeight ? (graph.springWeight[e] ?? 1) : 1;
    for (const [i, j] of [[s, t], [t, s]] as const) {
      for (let c = 0; c < 2; c++) {
        const term = w * ((p[j * 2 + c] ?? 0) - (p[i * 2 + c] ?? 0));
        force[i * 2 + c] = (force[i * 2 + c] ?? 0) + a * term;
        scale[i * 2 + c] = (scale[i * 2 + c] ?? 0) + a * Math.abs(term);
      }
      degree[i] = (degree[i] ?? 0) + 1;
    }
  }
  const depth = degree.map((d) => (d > SPRING_CHUNK ? HUB_CHUNK + Math.ceil(d / HUB_CHUNK) : d));
  return { force, scale, depth };
}

/** Rows whose GPU force lies outside the magnitude-scaled bound, as `node:component` labels. */
function rowsOutsideBound(gpu: Float32Array, ref: SpringReference): string[] {
  const bad: string[] = [];
  for (let i = 0; i < ref.depth.length; i++) {
    for (let c = 0; c < 2; c++) {
      const k = i * 2 + c;
      const bound = 2 * Math.max(1, ref.depth[i] ?? 1) * EPS * (ref.scale[k] ?? 0);
      if (!(Math.abs((gpu[k] ?? NaN) - (ref.force[k] ?? 0)) <= bound)) bad.push(`${i}:${c}`);
    }
  }
  return bad;
}

/** A star: hub 0 at the origin, `leaves` leaves in a box offset to +x, so the hub's sum is large. */
function makeStar(leaves: number, seed: number): LayoutGraph {
  const rng = makePrng(seed);
  const positions = new Float32Array((leaves + 1) * 2);
  for (let k = 1; k <= leaves; k++) {
    positions[k * 2] = 100 + 300 * rng();
    positions[k * 2 + 1] = -150 + 300 * rng();
  }
  // Alternate the edge direction so both CSR scatter orders appear in the hub row.
  const source = Uint32Array.from({ length: leaves }, (_, e) => (e % 2 === 0 ? 0 : e + 1));
  const target = Uint32Array.from({ length: leaves }, (_, e) => (e % 2 === 0 ? e + 1 : 0));
  return { nodeCount: leaves + 1, edgeCount: leaves, source, target, positions };
}

/**
 * web-NotreDame's degree shape in miniature: its five > 4096 hubs (10,721 … 4,283) plus rows right at
 * the chunk boundary (255, 256, 257, 512, 513) and a 1000, each linked to random nodes of a 20,000-node
 * pool that also carries a sparse random graph of its own (low-degree rows on the plain gather).
 */
const HUB_DEGREES = [10_721, 7_636, 7_026, 4_321, 4_283, 1_000, 513, 512, 257, 256, 255];

function makeHubMix(seed: number, weighted: boolean): LayoutGraph {
  const rng = makePrng(seed);
  const hubDegrees = HUB_DEGREES;
  const pool = 20_000;
  const H = hubDegrees.length;
  const nodeCount = H + pool;
  const src: number[] = [];
  const tgt: number[] = [];
  hubDegrees.forEach((degree, h) => {
    // `degree` distinct pool nodes: a random rotation of a stride walk (the stride is coprime to the pool).
    const offset = Math.floor(rng() * pool);
    for (let k = 0; k < degree; k++) {
      const leaf = H + ((offset + k * 7919) % pool);
      if (k % 2 === 0) { src.push(h); tgt.push(leaf); } else { src.push(leaf); tgt.push(h); }
    }
  });
  for (let k = 0; k < pool; k++) {
    src.push(H + Math.floor(rng() * pool));
    tgt.push(H + Math.floor(rng() * pool));
  }
  const positions = new Float32Array(nodeCount * 2);
  for (let i = 0; i < nodeCount; i++) {
    // An offset distribution (centre 1000, spread 400): terms of both signs, sums that partly cancel.
    positions[i * 2] = 1000 + 400 * (rng() - 0.5);
    positions[i * 2 + 1] = -600 + 400 * (rng() - 0.5);
  }
  const graph: LayoutGraph = {
    nodeCount,
    edgeCount: src.length,
    source: Uint32Array.from(src),
    target: Uint32Array.from(tgt),
    positions,
  };
  if (weighted) graph.springWeight = Float32Array.from(src, () => 0.25 + 2 * rng());
  return graph;
}

describe("GPU springs vs a float64 reference (#350, T4)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("a 20,000-leaf star: the hub row and every leaf row are within the magnitude-scaled bound", () => {
    const star = makeStar(20_000, 0x5a7a2);
    const gpu = gpuSpringForces(device, star);
    const ref = referenceForces(star);
    expect(rowsOutsideBound(gpu, ref)).toEqual([]);
    // The hub row is the one the old cap truncated at 4096 of 20,000 entries: a quarter of its force.
    const hub = Math.hypot(gpu[0] ?? 0, gpu[1] ?? 0);
    const exact = Math.hypot(ref.force[0] ?? 0, ref.force[1] ?? 0);
    expect(Math.abs(hub - exact) / exact).toBeLessThan(1e-4);
  });

  it("action-reaction holds: the springs' net force vanishes within the rounding bound", () => {
    // Σ_i F_i = attraction · Σ_edges ((p_t − p_s) + (p_s − p_t)) = 0 exactly; on the GPU it is only the
    // rounding of every row, so |Σ F| ≤ 2 · D_max · ε · Σ_i scale_i. The capped gather missed 15,904 of
    // the hub's terms here — a net force of ~80% of the hub's — which this would have caught.
    const star = makeStar(20_000, 0xac7);
    const gpu = gpuSpringForces(device, star);
    const ref = referenceForces(star);
    const dMax = Math.max(...ref.depth);
    for (let c = 0; c < 2; c++) {
      let net = 0, total = 0;
      for (let i = 0; i < star.nodeCount; i++) {
        net += gpu[i * 2 + c] ?? NaN;
        total += ref.scale[i * 2 + c] ?? 0;
      }
      expect(Math.abs(net)).toBeLessThanOrEqual(2 * dMax * EPS * total);
    }
  });

  for (const weighted of [false, true]) {
    it(`web-NotreDame-shaped hubs and rows at the chunk boundary${weighted ? ", with spring weights" : ""}: every row within the bound`, () => {
      const graph = makeHubMix(weighted ? 0x3e1 : 0xd09, weighted);
      const springs = new GpuSprings(device, graph);
      // Every hub above C is chunked (10,721 → 168 chunks … 257 → 5); 256 and 255 stay on the row gather,
      // and no pool row comes near C (≤ 11 hub links plus a sparse random graph).
      const chunked = HUB_DEGREES.filter((d) => d > SPRING_CHUNK);
      expect(chunked).not.toContain(256);
      expect(springs.hubChunkCount).toBe(chunked.reduce((n, d) => n + Math.ceil(d / HUB_CHUNK), 0));
      springs.destroy();
      const gpu = gpuSpringForces(device, graph);
      expect(rowsOutsideBound(gpu, referenceForces(graph))).toEqual([]);
    });
  }

  it("is deterministic: the same inputs give bitwise-identical forces", () => {
    const graph = makeHubMix(0x77, false);
    const a = gpuSpringForces(device, graph);
    const b = gpuSpringForces(device, graph);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("a graph without hub rows encodes no chunk pass; a hub graph encodes exactly one", () => {
    const plain = makeStar(SPRING_CHUNK, 1); // the hub row is exactly C: still the row gather
    const hubbed = makeStar(SPRING_CHUNK + 1, 1);
    const spy = vi.spyOn(device, "beginRenderPass");
    for (const [graph, chunks, passes] of [[plain, 0, 0], [hubbed, Math.ceil((SPRING_CHUNK + 1) / HUB_CHUNK), 1]] as const) {
      const pos = packPositionsTexture(device, graph.positions);
      const springs = new GpuSprings(device, graph);
      expect(springs.hubChunkCount).toBe(chunks);
      spy.mockClear();
      springs.prepare(pos.texture, pos.width);
      expect(spy).toHaveBeenCalledTimes(passes);
      springs.destroy();
      pos.texture.destroy();
    }
    spy.mockRestore();
  });
});
