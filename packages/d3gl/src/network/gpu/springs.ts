import type { Device, Framebuffer, RenderPass, Texture } from "@luma.gl/core";
import type { LayoutGraph } from "../force.js";
import { buildCSR } from "../graph.js";
import { buildHubChunks } from "./hub-chunks.js";
import { atlasWidth, packFloatTexture, packUintTexture } from "./textures.js";
import { AttractionPass, HubChunkPass, type CsrTextures, type HubChunkTextures, type NestedSpringInputs } from "./passes/attraction.js";
import { beginPass } from "./passes/fullscreen.js";

/** Uniforms for one spring draw. */
export interface SpringUniforms {
  /** Number of real nodes (not padded). */
  count: number;
  /** Position atlas width. */
  width: number;
  /** Spring strength (`ForceParams.attraction`). */
  attraction: number;
}

/** The hub half: the chunk table, its partial sums, the partials framebuffer and the chunk pass. */
interface HubResources extends HubChunkTextures {
  readonly fbo: Framebuffer;
  readonly pass: HubChunkPass;
}

/**
 * The GPU layout's springs (#350): the symmetric CSR in textures, the hub chunk table, and the two
 * passes that turn them into per-node spring forces. Everything is created once here, for the graph's
 * fixed topology; a tick only encodes draws.
 *
 * Per tick, {@link prepare} encodes the hub chunk pass (its own render pass, before the force pass) and
 * {@link draw} draws the row gather into the open force pass. Rows of at most `SPRING_CHUNK` entries
 * are gathered one fragment per node exactly as before; longer rows are summed in chunks of at most
 * `HUB_CHUNK` entries and their fragment adds the partials. So every CSR entry is gathered once (O(2E)
 * per tick) and no fragment loops more than `SPRING_CHUNK` times (up to degree `SPRING_CHUNK ·
 * HUB_CHUNK`). A graph without such rows compiles no hub code and encodes no extra pass.
 *
 * With `graph.springWeight`, each CSR entry carries its edge's weight (an `r32float` texture parallel to
 * the neighbours) and every term is multiplied by it, as the CPU {@link ForceLayout} does for unit-mass
 * weighted springs. Without it the programs compile with no weight fetch. A per-node `mass` (a coarse
 * multilevel level's `k / mass` per endpoint) is not applied here yet: the GPU seed levels do not carry
 * one (spec §8, gpu-ml-seed-plain).
 *
 * With `nested` (#355), the terms are the nested layout's link corrections instead (see
 * {@link SpringVariant.nested}): they need the graph's `springWeight` and the {@link NestedSpringInputs}
 * on every {@link prepare} and {@link draw}.
 */
export class GpuSprings {
  private readonly device: Device;
  private readonly csr: CsrTextures;
  private readonly offWidth: number;
  private readonly nbrWidth: number;
  private readonly attraction: AttractionPass;
  private readonly hubs: HubResources | null;
  private readonly nested: boolean;

  constructor(device: Device, graph: LayoutGraph, variant: { nested?: boolean } = {}) {
    this.device = device;
    this.nested = variant.nested === true;
    if (this.nested && !graph.springWeight) throw new Error("GpuSprings: nested springs need per-link weights");
    // Symmetric (undirected) CSR from the directed edge list: buildCSR inserts both directions, so the
    // gather reproduces force.ts's per-edge springs (each edge pulls both endpoints).
    const csr = buildCSR(graph.nodeCount, graph.source, graph.target, graph.springWeight);

    const offResult = packUintTexture(device, csr.offsets);
    this.offWidth = offResult.width;
    // neighbors may be empty (no edges) — a 1×1 zeroed texture then stands in, never fetched.
    const nbrResult = packUintTexture(device, csr.neighbors.length > 0 ? csr.neighbors : new Uint32Array(1));
    this.nbrWidth = nbrResult.width;
    // The weights atlas has the neighbours' length, hence their width: the shader addresses both with one
    // coordinate.
    const weights = csr.weights
      ? packFloatTexture(device, csr.weights.length > 0 ? csr.weights : new Float32Array(1)).texture
      : null;
    this.csr = { offsets: offResult.texture, neighbors: nbrResult.texture, weights };

    const table = buildHubChunks(csr.offsets);
    const weighted = weights !== null;
    this.hubs = table.count > 0 ? createHubResources(device, table.table, table.count, weighted, this.nested) : null;
    this.attraction = new AttractionPass(device, { hubs: this.hubs !== null, weighted, nested: this.nested });
  }

  /** Number of hub chunks (0 when no row is longer than `SPRING_CHUNK`). */
  get hubChunkCount(): number {
    return this.hubs?.count ?? 0;
  }

  /**
   * Encode the hub chunk pass over the current positions: its own render pass into the partials
   * texture, submitted before the caller opens the force pass that {@link draw}s into. No-op (no render
   * pass, no draw) when the graph has no hubs.
   */
  prepare(posTex: Texture, width: number, nested?: NestedSpringInputs): void {
    const hubs = this.hubs;
    if (!hubs) return;
    // Every partials texel is written (padding with 0), so the target is never cleared.
    const pass = beginPass(this.device, { framebuffer: hubs.fbo, clear: false });
    hubs.pass.run(pass, posTex, this.csr, hubs, { width, nbrWidth: this.nbrWidth }, nested);
    pass.end();
    this.device.submit();
  }

  /** Draw the spring forces into an open additive force pass, after {@link prepare} for this tick. */
  draw(pass: RenderPass, posTex: Texture, u: SpringUniforms, nested?: NestedSpringInputs): void {
    this.attraction.run(pass, posTex, this.csr, this.hubs, {
      count: u.count,
      width: u.width,
      offWidth: this.offWidth,
      nbrWidth: this.nbrWidth,
      attraction: u.attraction,
    }, nested);
  }

  destroy(): void {
    this.csr.offsets.destroy();
    this.csr.neighbors.destroy();
    this.csr.weights?.destroy();
    this.attraction.destroy();
    if (this.hubs) {
      this.hubs.fbo.destroy();
      this.hubs.chunks.destroy();
      this.hubs.partials.destroy();
      this.hubs.pass.destroy();
    }
  }
}

/** Upload the chunk table (`rgba32uint`) and allocate its partials target (`rg32float`, same atlas). */
function createHubResources(device: Device, table: Uint32Array, count: number, weighted: boolean, nested: boolean): HubResources {
  const width = atlasWidth(count);
  const height = Math.ceil(count / width);
  const padded = new Uint32Array(width * height * 4);
  padded.set(table);
  const chunks = device.createTexture({
    width, height, format: "rgba32uint", data: padded, mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  const partials = device.createTexture({
    width, height, format: "rg32float", mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  const fbo = device.createFramebuffer({ width, height, colorAttachments: [partials] });
  return { chunks, partials, count, width, fbo, pass: new HubChunkPass(device, { weighted, nested }) };
}
