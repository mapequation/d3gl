import type { Device, Framebuffer, RenderPass, SamplerProps, Texture } from "@luma.gl/core";
import { GpuSprings, createSeedSpringPasses, type SeedSpringPasses } from "./springs.js";
import { LeafSeedPass } from "./passes/leaf-seed.js";
import { ProlongatePass } from "./passes/prolongate.js";
import { beginPass } from "./passes/fullscreen.js";
import { seedPlanCapacity, type SeedPlan } from "./seed-plan.js";
import { atlasWidth, writeTexels } from "./textures.js";

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

/**
 * Every program a multilevel seed runs besides the solver's own (#353): the seed springs' row gather and chunk
 * pass, the prolongation and the leaf seed. None depends on a plan, so a solver built with `multilevel`
 * compiles them at its construction — a compile or link failure then fails the construction, where the
 * transport falls back to the worker, and a seed never compiles in the frame loop. Owned by the solver.
 */
export class SeedPasses {
  readonly springs: SeedSpringPasses;
  readonly prolongate: ProlongatePass;
  readonly leaf: LeafSeedPass;

  constructor(device: Device) {
    this.springs = createSeedSpringPasses(device);
    this.prolongate = new ProlongatePass(device);
    this.leaf = new LeafSeedPass(device);
  }

  destroy(): void {
    this.springs.attraction.destroy();
    this.springs.hubChunk.destroy();
    this.prolongate.destroy();
    this.leaf.destroy();
  }
}

/** The node-order leaf seed of a module-tree plan: its texture, framebuffer and leaf-entry table. */
interface LeafResources {
  /** Node-order positions of every terminal leaf so far (`rg32float`, the slot atlas). */
  readonly seed: Texture;
  readonly fbo: Framebuffer;
  /** One level's `(slot, node)` entries (`rg32uint`), rewritten per level. */
  readonly entries: Texture;
  readonly entriesWidth: number;
  readonly entryRow: Uint32Array;
}

/** Something {@link SeedLevels} created and frees. */
interface Owned {
  destroy(): void;
}

/**
 * What a multilevel seed (#353, spec §6.4) needs only while it runs, created once when it starts
 * (`GpuForceLayout.beginSeed`) and freed when the graph's nodes are placed (`endSeed`): per-slot mass and
 * stabilizer textures sized to the largest level, the parent-slot table the prolongation reads, the seed's
 * own springs, and — for a module tree — the node-order leaf seed. Every level is written into these with
 * sub-uploads of the texels it fills ({@link upload}), so changing level allocates nothing. It creates
 * textures and framebuffers only: its programs are the solver's {@link SeedPasses}.
 *
 * GPU memory (W = the solver's atlas width, H its rows, n₁ the largest level's slots, e₁ its CSR entries):
 * mass + stabilizer `2 · 4 · W · ⌈n₁ / W⌉` B, parent slots `4 · W · H` B, springs `4 · (n₁ + 1) + 8 · e₁` B
 * plus 24 B per hub chunk, and a module tree's leaf seed `8 · W · H` B plus 8 B per leaf of its largest
 * level. The offsets ride in the solver's force texture, which is free between levels (the first tick
 * clears it).
 */
export class SeedLevels {
  readonly plan: SeedPlan;
  /** The seed levels' springs (weighted, mass-weighted), rewritten per level. */
  readonly springs: GpuSprings;
  /** Per-slot masses of the current level (`r32float`, slot atlas). */
  readonly mass: Texture;
  /** Per-slot stabilizers of the current level (`r32float`, slot atlas). */
  readonly stab: Texture;
  /** Per-slot parent slots of the placement being prolongated (`r32uint`, the whole slot atlas). */
  readonly parent: Texture;
  readonly prolongate: ProlongatePass;
  private readonly device: Device;
  private readonly width: number;
  private readonly height: number;
  private readonly leaf: LeafResources | null;
  private readonly leafPass: LeafSeedPass;
  private readonly floatRow: Float32Array;
  private readonly uintRow: Uint32Array;
  /** Everything created here, in creation order: freed by {@link destroy}, or at once if creating one fails. */
  private readonly owned: Owned[] = [];

  constructor(device: Device, plan: SeedPlan, width: number, height: number, passes: SeedPasses) {
    this.device = device;
    this.plan = plan;
    this.width = width;
    this.height = height;
    this.prolongate = passes.prolongate;
    this.leafPass = passes.leaf;
    this.floatRow = new Float32Array(width * 2);
    this.uintRow = new Uint32Array(width);
    const own = <T extends Owned>(resource: T): T => {
      this.owned.push(resource);
      return resource;
    };
    try {
      const cap = seedPlanCapacity(plan);
      const rows = Math.max(1, Math.ceil(cap.slots / width));
      const float = (h: number): Texture => own(device.createTexture({ width, height: h, format: "r32float", mipLevels: 1, sampler: NEAREST }));
      this.mass = float(rows);
      this.stab = float(rows);
      this.parent = own(device.createTexture({ width, height, format: "r32uint", mipLevels: 1, sampler: NEAREST }));
      this.springs = own(new GpuSprings(device, { seedLevels: { rows: cap.slots, entries: cap.entries, chunks: cap.chunks }, passes: passes.springs }));
      if (plan.finest) {
        this.leaf = null;
      } else {
        const seed = own(device.createTexture({ width, height, format: "rg32float", mipLevels: 1, sampler: NEAREST }));
        const entriesWidth = atlasWidth(Math.max(1, cap.leaves));
        this.leaf = {
          seed,
          fbo: own(device.createFramebuffer({ width, height, colorAttachments: [seed] })),
          entries: own(device.createTexture({
            width: entriesWidth,
            height: Math.ceil(Math.max(1, cap.leaves) / entriesWidth),
            format: "rg32uint",
            mipLevels: 1,
            sampler: NEAREST,
          })),
          entriesWidth,
          entryRow: new Uint32Array(entriesWidth * 2),
        };
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /**
   * Make level `k` the current one: its parent slots and offsets (into `offsetTex`, the solver's force
   * texture) for the prolongation, its masses, stabilizers and springs for its ticks. Sub-uploads only.
   */
  upload(k: number, offsetTex: Texture): void {
    const level = this.plan.levels[k];
    if (!level) throw new Error(`SeedLevels.upload: no level ${k}`);
    const { width } = this;
    writeTexels(this.parent, level.parent, level.count, width, 1, this.uintRow);
    writeTexels(offsetTex, level.offset, level.count, width, 2, this.floatRow);
    writeTexels(this.mass, level.mass, level.count, width, 1, this.floatRow);
    writeTexels(this.stab, level.stab, level.count, width, 1, this.floatRow);
    this.springs.setRows(level);
  }

  /**
   * The graph's nodes: upload their parent slots and offsets (into `offsetTex`) and return true, or return
   * false when the plan gathers them from the leaf seed instead.
   */
  uploadFinest(offsetTex: Texture): boolean {
    const finest = this.plan.finest;
    if (!finest) return false;
    writeTexels(this.parent, finest.parent, this.plan.nodeCount, this.width, 1, this.uintRow);
    writeTexels(offsetTex, finest.offset, this.plan.nodeCount, this.width, 2, this.floatRow);
    return true;
  }

  /**
   * Move level `k`'s terminal leaves from `posTex` (the level's positions) to their nodes' texels of the leaf
   * seed: one point each, its own render pass. No-op for a level without leaves.
   */
  scatterLeaves(k: number, posTex: Texture): void {
    const level = this.plan.levels[k];
    const leaf = this.leaf;
    if (!level || !leaf || level.leaves.length === 0) return;
    const leaves = level.leaves.length / 2;
    writeTexels(leaf.entries, level.leaves, leaves, leaf.entriesWidth, 2, leaf.entryRow);
    const pass = beginPass(this.device, { framebuffer: leaf.fbo, clear: false });
    this.leafPass.scatter(pass, posTex, leaf.entries, leaf.entriesWidth, leaves, this.width, this.height);
    pass.end();
    this.device.submit();
  }

  /** Copy the leaf seed (every node) into an open MRT `[position, velocity]` pass. */
  gatherLeaves(pass: RenderPass): void {
    if (!this.leaf) throw new Error("SeedLevels.gatherLeaves: the plan prolongates its nodes");
    this.leafPass.gather(pass, this.leaf.seed, this.plan.nodeCount, this.width);
  }

  /** Free everything created for this plan (the programs stay: they are the solver's). */
  destroy(): void {
    // Newest first, so a framebuffer goes before the texture it draws into.
    for (let i = this.owned.length - 1; i >= 0; i--) this.owned[i]?.destroy();
    this.owned.length = 0;
  }
}
