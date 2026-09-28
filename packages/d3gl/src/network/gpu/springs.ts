import type { Device, Framebuffer, RenderPass, SamplerProps, Texture } from "@luma.gl/core";
import type { LayoutGraph } from "../force.js";
import { buildCSR, type CSR } from "../graph.js";
import { buildHubChunks, hasHubRows } from "./hub-chunks.js";
import { atlasWidth, packFloatTexture, packUintTexture, writeTexels } from "./textures.js";
import {
  AttractionPass,
  HubChunkPass,
  attractionProgram,
  hubChunkProgram,
  type CsrTextures,
  type HubChunkTextures,
  type NestedSpringInputs,
  type SpringVariant,
} from "./passes/attraction.js";
import type { LayoutProgram } from "./programs.js";
import { beginPass } from "./passes/fullscreen.js";
import type { SeedLevel } from "./seed-plan.js";

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

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
  /** Chunks of the current rows: all of them for a graph's springs, the current level's for a seed's. */
  count: number;
}

/**
 * A multilevel seed's spring programs (#353): the weighted, mass-weighted row gather with the hub branch, and
 * the weighted chunk pass. They depend on no plan, so a multilevel solver compiles them at its construction
 * ({@link createSeedSpringPasses}) and every seed's springs borrow them.
 */
export interface SeedSpringPasses {
  readonly attraction: AttractionPass;
  readonly hubChunk: HubChunkPass;
}

/** The seed springs' variant: weighted and mass-weighted, with the hub branch (#353). */
const SEED_SPRINGS: SpringVariant = { hubs: true, weighted: true, massive: true };

/** Compile a multilevel seed's spring programs (owned by the solver, destroyed with it). */
export function createSeedSpringPasses(device: Device): SeedSpringPasses {
  return {
    attraction: new AttractionPass(device, SEED_SPRINGS),
    hubChunk: new HubChunkPass(device, SEED_SPRINGS),
  };
}

/** The programs {@link createSeedSpringPasses} compiles (#385). */
export function seedSpringPrograms(): LayoutProgram[] {
  return [attractionProgram(SEED_SPRINGS), hubChunkProgram(SEED_SPRINGS)];
}

/**
 * A layout graph that carries its undirected CSR's row lengths — a `NetworkGraph` does (`graph.csr`, built from the
 * same edges by the same `buildCSR` as the solver's springs) — so its springs' variant is known before the solver.
 */
export type SpringGraph = LayoutGraph & { readonly csr: Pick<CSR, "degree"> };

/**
 * The variant a graph's {@link GpuSprings} compile (#385): the hub branch when some CSR row is longer than
 * `SPRING_CHUNK` (the rows {@link buildHubChunks} splits), read from the row lengths `degree` (no pass over the
 * edges), weights when the graph has them, and the nested terms for `nested` springs.
 */
export function springVariant(graph: Pick<LayoutGraph, "springWeight">, degree: ArrayLike<number>, nested = false): SpringVariant {
  return { hubs: hasHubRows(degree), weighted: graph.springWeight !== undefined, nested };
}

/** The programs a graph's {@link GpuSprings} compile: the row gather, and the chunk pass when it has hubs (#385). */
export function springPrograms(variant: SpringVariant): LayoutProgram[] {
  return variant.hubs ? [attractionProgram(variant), hubChunkProgram(variant)] : [attractionProgram(variant)];
}

/**
 * The sizes a multilevel seed's springs are allocated for (#353) — the most rows, CSR entries and hub chunks
 * of any seed level (`seedPlanCapacity`) — and the programs they borrow.
 */
export interface SeedSpringCapacity {
  readonly seedLevels: { readonly rows: number; readonly entries: number; readonly chunks: number };
  readonly passes: SeedSpringPasses;
}

/** One row of scratch per texture width, for the partial last row of each level's upload (allocated once). */
interface SeedStaging {
  readonly offsetRow: Uint32Array;
  readonly neighborRow: Uint32Array;
  readonly weightRow: Float32Array;
  readonly chunkRow: Uint32Array;
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
 * weighted springs. Without it the programs compile with no weight fetch.
 *
 * With `nested` (#355), the terms are the nested layout's link corrections instead (see
 * {@link SpringVariant.nested}): they need the graph's `springWeight` and the {@link NestedSpringInputs}
 * on every {@link prepare} and {@link draw}. A `rowScale` (the nested solve's per-slot spring relaxation,
 * `NestedSolverTopology.springScale`) multiplies every entry of node i's CSR row by `rowScale[i]`, once
 * here: node i's own spring terms scale, its neighbours' terms toward it do not, and a tick is unchanged.
 *
 * **A multilevel seed's springs** (#353) are a second set, built from a {@link SeedSpringCapacity}: textures
 * sized to the largest seed level, weighted and mass-weighted (each row's sum divided by its slot's mass —
 * the CPU's `k · w / mass` per endpoint), rewritten per level by {@link setRows} with sub-uploads (no
 * allocation). Their programs are the solver's ({@link SeedSpringPasses}, compiled with it), so building a
 * seed's springs compiles nothing. The finest level keeps its own set, untouched by the seed.
 */
export class GpuSprings {
  private readonly device: Device;
  private readonly csr: CsrTextures;
  private readonly offWidth: number;
  private readonly nbrWidth: number;
  private readonly attraction: AttractionPass;
  private readonly hubs: HubResources | null;
  private readonly staging: SeedStaging | null;
  /** A graph's springs own their programs; a seed's borrow the solver's ({@link SeedSpringPasses}). */
  private readonly ownsPasses: boolean;
  private readonly nested: boolean;

  constructor(
    device: Device,
    source: LayoutGraph | SeedSpringCapacity,
    variant: { nested?: boolean; rowScale?: Float32Array } = {},
  ) {
    this.device = device;
    this.nested = variant.nested === true;
    if ("seedLevels" in source) {
      if (this.nested) throw new Error("GpuSprings: a seed's springs are not nested");
      const { rows, entries, chunks } = source.seedLevels;
      this.offWidth = atlasWidth(rows + 1);
      this.nbrWidth = atlasWidth(Math.max(1, entries));
      const offRows = Math.ceil((rows + 1) / this.offWidth);
      const nbrRows = Math.ceil(Math.max(1, entries) / this.nbrWidth);
      const uint = (width: number, height: number): Texture =>
        device.createTexture({ width, height, format: "r32uint", mipLevels: 1, sampler: NEAREST });
      this.csr = {
        offsets: uint(this.offWidth, offRows),
        neighbors: uint(this.nbrWidth, nbrRows),
        weights: device.createTexture({ width: this.nbrWidth, height: nbrRows, format: "r32float", mipLevels: 1, sampler: NEAREST }),
      };
      // The borrowed row gather is compiled with the hub branch, so its hub textures are always bound: at
      // least one chunk's (24 B) when no level has a hub row, which that branch then never reads.
      const capacity = Math.max(1, chunks);
      this.hubs = createHubResources(device, new Uint32Array(capacity * 4), capacity, source.passes.hubChunk);
      this.hubs.count = 0;
      this.staging = {
        offsetRow: new Uint32Array(this.offWidth),
        neighborRow: new Uint32Array(this.nbrWidth),
        weightRow: new Float32Array(this.nbrWidth),
        chunkRow: new Uint32Array(this.hubs.width * 4),
      };
      this.attraction = source.passes.attraction;
      this.ownsPasses = false;
      return;
    }
    this.staging = null;
    this.ownsPasses = true;
    const graph = source;
    if (this.nested && !graph.springWeight) throw new Error("GpuSprings: nested springs need per-link weights");
    // Symmetric (undirected) CSR from the directed edge list: buildCSR inserts both directions, so the
    // gather reproduces force.ts's per-edge springs (each edge pulls both endpoints).
    const csr = buildCSR(graph.nodeCount, graph.source, graph.target, graph.springWeight);
    const { rowScale } = variant;
    if (rowScale && csr.weights) scaleRows(csr.offsets, csr.weights, rowScale);

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
    this.hubs = table.count > 0 ? createHubResources(device, table.table, table.count, new HubChunkPass(device, { weighted, nested: this.nested })) : null;
    this.attraction = new AttractionPass(device, { hubs: this.hubs !== null, weighted, nested: this.nested });
  }

  /** Number of hub chunks (0 when no row is longer than `SPRING_CHUNK`). */
  get hubChunkCount(): number {
    return this.hubs?.count ?? 0;
  }

  /**
   * A seed's springs only: make `level`'s CSR, weights and hub chunks the rows drawn — sub-uploads of the
   * rows each one fills, through staging allocated once, so changing level allocates nothing (#353).
   */
  setRows(level: SeedLevel): void {
    const staging = this.staging;
    if (!staging) throw new Error("GpuSprings.setRows: only a seed's springs change their rows");
    writeTexels(this.csr.offsets, level.offsets, level.offsets.length, this.offWidth, 1, staging.offsetRow);
    writeTexels(this.csr.neighbors, level.neighbors, level.neighbors.length, this.nbrWidth, 1, staging.neighborRow);
    if (this.csr.weights) writeTexels(this.csr.weights, level.weights, level.weights.length, this.nbrWidth, 1, staging.weightRow);
    const hubs = this.hubs;
    if (hubs) {
      writeTexels(hubs.chunks, level.chunks, level.chunkCount, hubs.width, 4, staging.chunkRow);
      hubs.count = level.chunkCount;
    } else if (level.chunkCount > 0) {
      throw new Error("GpuSprings.setRows: a level with hub rows needs capacity for its chunks");
    }
  }

  /**
   * Encode the hub chunk pass over the current positions: its own render pass into the partials
   * texture, encoded before the caller opens the force pass that {@link draw}s into. No-op (no render
   * pass, no draw) when the graph has no hubs.
   */
  prepare(posTex: Texture, width: number, nested?: NestedSpringInputs): void {
    const hubs = this.hubs;
    if (!hubs || hubs.count === 0) return;
    // Every partials texel is written (padding with 0), so the target is never cleared.
    const pass = beginPass(this.device, { framebuffer: hubs.fbo, clear: false });
    hubs.pass.run(pass, posTex, this.csr, hubs, { width, nbrWidth: this.nbrWidth }, nested);
    pass.end();
  }

  /**
   * Draw the spring forces into an open additive force pass, after {@link prepare} for this tick. A seed's
   * springs take the level's per-slot `mass` texture (each row's sum is an acceleration on it); nested
   * springs (#355) their {@link NestedSpringInputs}.
   */
  draw(pass: RenderPass, posTex: Texture, u: SpringUniforms, mass: Texture | null = null, nested?: NestedSpringInputs): void {
    this.attraction.run(pass, posTex, this.csr, this.hubs, {
      count: u.count,
      width: u.width,
      offWidth: this.offWidth,
      nbrWidth: this.nbrWidth,
      attraction: u.attraction,
    }, mass, nested);
  }

  destroy(): void {
    this.csr.offsets.destroy();
    this.csr.neighbors.destroy();
    this.csr.weights?.destroy();
    if (this.ownsPasses) this.attraction.destroy();
    if (this.hubs) {
      this.hubs.fbo.destroy();
      this.hubs.chunks.destroy();
      this.hubs.partials.destroy();
      if (this.ownsPasses) this.hubs.pass.destroy();
    }
  }
}

/** In place: every entry of row i of a CSR (`offsets`, `weights`) times `scale[i]`. O(entries), once. */
function scaleRows(offsets: Uint32Array, weights: Float32Array, scale: Float32Array): void {
  for (let i = 0; i + 1 < offsets.length; i++) {
    const f = scale[i] ?? 1;
    if (f === 1) continue;
    for (let p = offsets[i] ?? 0; p < (offsets[i + 1] ?? 0); p++) weights[p] = (weights[p] ?? 0) * f;
  }
}

/** Upload the chunk table (`rgba32uint`) and allocate its partials target (`rg32float`, same atlas) for `pass`. */
function createHubResources(device: Device, table: Uint32Array, count: number, pass: HubChunkPass): HubResources {
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
  return { chunks, partials, count, width, fbo, pass };
}
