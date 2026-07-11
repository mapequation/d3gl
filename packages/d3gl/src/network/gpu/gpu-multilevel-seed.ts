/**
 * Module-aware GPU multilevel seed (sub-issue #180 / N8.2, epic #98 / #106).
 *
 * Seeds the GPU force layout **top-down over the provided module hierarchy** — the same
 * {@link LODTopology} the renderer's LOD cut uses — so modules lay out as coherent regions instead of
 * the plain phyllotaxis disc {@link seedPositions} produces. This replaces the disc seed in
 * {@link ./gpu-transport.js} whenever a module tree (with super-edges) is available.
 *
 * ## Why traverse by DEPTH, not the LOD height-levels
 * An Infomap module tree is **ragged**: one leaf may sit directly under a top module, another three
 * modules down. `LODTopology.levelOffset` groups modules by **height** (for the renderer's bottom-up
 * geometry passes), which mixes a shallow branch's top module with a deep branch's mid module — the
 * wrong unit for a top-down solve. So the seed derives each tree node's **depth** from `parent[]`
 * (root = 0; a node's depth = its parent's + 1) and traverses depth-by-depth from the roots down. A
 * **leaf is structural** — any node with no children — so a leaf that first appears at depth 1 is
 * placed by its parent's prolongation there and never touched at deeper depths (ragged handled by
 * construction; see the ragged test).
 *
 * ## Per-level work is GPU-parallel and O(level size) — no CPU "it's small" shortcut
 * The one-time CPU precompute is O(tree size + super-edges) (depth, per-depth slot maps, per-depth
 * super-edge CSRs in slot ids, golden-angle offsets) — data prep, not a force solve. Then per depth,
 * from the top down:
 *  - **Prolongate** (GPU gather, {@link ProlongatePass}) — each child samples its parent's position +
 *    a deterministic golden-angle offset. One pass, O(level size), no CPU loop over the level.
 *  - **Solve** (GPU force passes via {@link GpuForceLayout}) — repulsion pyramid + attraction over the
 *    level's super-edges + centering + integrate. Levels larger than {@link maxSeedNodes} are
 *    prolongated **without** a solve (their detail is left to the finest-level refine the caller runs),
 *    bounding the seed cost — mirroring the CPU {@link multilevelSeed}'s `maxSeedNodes`. **Never** a
 *    CPU per-level force loop (that is the exact thing #180 exists to avoid).
 *
 * The finest positions (each leaf's, gathered from whichever depth it terminates at) land in
 * `graph.positions`; the caller's finest-level {@link GpuForceLayout} refine (real edges) then polishes.
 */
import type { Device, Texture, Framebuffer } from "@luma.gl/core";
import type { ForceParams, LayoutGraph } from "../force.js";
import { DEFAULT_FORCE, seedPositions } from "../force.js";
import type { LODTopology } from "../lod.js";
import { GpuForceLayout } from "./gpu-force-layout.js";
import { ProlongatePass } from "./passes/prolongate.js";
import { atlasWidth, packPositionsTexture, packUintTexture, readbackFloatFboReuse } from "./textures.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const EMPTY_U32 = new Uint32Array(0);

/** Coarse-level refinement iterations, per solved level (few — each starts near-relaxed post-prolongation). */
const DEFAULT_COARSEN_ITERATIONS = 30;
/**
 * Largest level the seed force-**solves**; larger levels are prolongated through (no solve), so the
 * seed never runs a near-full GPU solve (the finest refine handles that detail). Bounds seed cost at
 * roughly O(Σ solved-level sizes · iterations). Generous vs. the CPU seed's 4096 because a GPU
 * Barnes-Hut level solve is cheap, so meso-scale module levels (thousands→tens-of-thousands) still
 * get a real solve.
 */
const DEFAULT_MAX_SEED_NODES = 20_000;

/** The minimal target the seed fills: node count + the interleaved positions buffer it writes. */
export interface SeedTarget {
  nodeCount: number;
  positions: Float32Array;
}

export interface GpuMultilevelSeedOptions {
  width: number;
  height: number;
  /** Force parameters for each level's solve (defaults to {@link DEFAULT_FORCE}). */
  force?: Partial<ForceParams>;
  /** Refinement iterations per solved level. Default {@link DEFAULT_COARSEN_ITERATIONS}. */
  coarsenIterations?: number;
  /** Levels larger than this are prolongated without a solve. Default {@link DEFAULT_MAX_SEED_NODES}. */
  maxSeedNodes?: number;
}

/**
 * Whether {@link gpuMultilevelSeed} can run for this topology: it needs the parent map + the directed
 * super-edge CSR (inter-module adjacency for each level's solve) with at least one super-edge, and its
 * leaves must align 1:1 with the graph's nodes. Module trees built with the graph's edges satisfy this;
 * module-less / edge-less graphs do not — the caller falls back to the plain disc seed there.
 */
export function canModuleSeed(topo: LODTopology, nodeCount: number): boolean {
  return (
    !!topo.parent &&
    !!topo.superEdgeOffset &&
    !!topo.superEdgeTarget &&
    topo.superEdgeTarget.length > 0 &&
    topo.leafCount === nodeCount &&
    topo.size > nodeCount
  );
}

/**
 * Seed `graph.positions` top-down over the module tree (see the file header). Assumes
 * {@link canModuleSeed} — falls back to {@link seedPositions} (disc) if the topology is unexpectedly
 * incomplete. The caller then constructs a finest-level {@link GpuForceLayout} over the real edges and
 * refines from this seed.
 */
export function gpuMultilevelSeed(
  device: Device,
  topo: LODTopology,
  graph: SeedTarget,
  opts: GpuMultilevelSeedOptions,
): void {
  const { width, height } = opts;
  const params: ForceParams = { ...DEFAULT_FORCE, ...opts.force };
  const coarsenIterations = opts.coarsenIterations ?? DEFAULT_COARSEN_ITERATIONS;
  const maxSeedNodes = opts.maxSeedNodes ?? DEFAULT_MAX_SEED_NODES;

  const { size, leafCount, parent, childOffset, children, superEdgeOffset, superEdgeTarget } = topo;
  if (!parent || !superEdgeOffset || !superEdgeTarget) {
    seedPositions({ nodeCount: graph.nodeCount, edgeCount: 0, source: EMPTY_U32, target: EMPTY_U32, positions: graph.positions }, width, height);
    return;
  }

  // ── 1. Depth of every tree node (root = 0). Module trees number a parent above all its children, so
  //       a single descending pass finalises each parent before its children (same trick as buildSuperEdges).
  const depth = new Int32Array(size);
  for (let g = size - 2; g >= 0; g--) depth[g] = depth[parent[g]!]! + 1;
  let maxDepth = 0;
  for (let g = 0; g < size; g++) if (depth[g]! > maxDepth) maxDepth = depth[g]!;
  if (maxDepth < 1) {
    seedPositions({ nodeCount: graph.nodeCount, edgeCount: 0, source: EMPTY_U32, target: EMPTY_U32, positions: graph.positions }, width, height);
    return;
  }

  // ── 2. Per-depth node CSR + each node's compact slot within its depth (ascending id → deterministic).
  const depthCount = new Uint32Array(maxDepth + 1);
  for (let g = 0; g < size; g++) depthCount[depth[g]!] = depthCount[depth[g]!]! + 1;
  const depthOffset = new Uint32Array(maxDepth + 2);
  for (let d = 0; d <= maxDepth; d++) depthOffset[d + 1] = depthOffset[d]! + depthCount[d]!;
  const slot = new Uint32Array(size);
  const depthNodes = new Uint32Array(size); // depth-ordered global ids: depthNodes[depthOffset[d] + s] = g
  const cur = depthOffset.slice(0, maxDepth + 1);
  for (let g = 0; g < size; g++) {
    const d = depth[g]!;
    const pos = cur[d]!;
    slot[g] = pos - depthOffset[d]!;
    depthNodes[pos] = g;
    cur[d] = pos + 1;
  }
  let maxLevel = 1;
  for (let d = 0; d <= maxDepth; d++) if (depthCount[d]! > maxLevel) maxLevel = depthCount[d]!;

  // ── 3. Sibling rank (a child's index within its parent's child list) — drives the golden-angle disc.
  const siblingRank = new Uint32Array(size);
  for (let p = 0; p < size; p++) {
    for (let k = childOffset[p]!; k < childOffset[p + 1]!; k++) siblingRank[children[k]!] = k - childOffset[p]!;
  }

  // ── 4. Per (depth-ordered) node: parent slot + golden-angle offset (a phyllotaxis disc around the
  //       parent). Disc radius adapts to the PARENT depth's density (≈ viewport / √parentLevelCount) so a
  //       child cluster stays smaller than the parent spacing. Stored in depth order for direct texture packing.
  const parentSlotByDepth = new Uint32Array(size);
  const offsetByDepth = new Float32Array(size * 2);
  const base = 0.4 * Math.min(width, height);
  for (let i = 0; i < size; i++) {
    const g = depthNodes[i]!;
    const p = parent[g]!;
    if (p < 0) continue; // root: parent slot 0, zero offset (already zeroed)
    parentSlotByDepth[i] = slot[p]!;
    const parentLevelCount = depthCount[depth[p]!]!;
    const sibCount = childOffset[p + 1]! - childOffset[p]!;
    const rank = siblingRank[g]!;
    const j = base / Math.sqrt(Math.max(parentLevelCount, 1));
    const r = j * Math.sqrt((rank + 0.5) / Math.max(sibCount, 1));
    const a = rank * GOLDEN;
    offsetByDepth[2 * i] = r * Math.cos(a);
    offsetByDepth[2 * i + 1] = r * Math.sin(a);
  }

  // ── 5. Per-depth super-edge lists in slot ids (directed out-edges; every super-edge connects two
  //       same-depth nodes, so bucket by the source's depth). GpuForceLayout symmetrises via buildCSR.
  const seCountByDepth = new Uint32Array(maxDepth + 1);
  for (let g = 0; g < size; g++) seCountByDepth[depth[g]!] = seCountByDepth[depth[g]!]! + (superEdgeOffset[g + 1]! - superEdgeOffset[g]!);
  const seSrc: Uint32Array[] = [];
  const seTgt: Uint32Array[] = [];
  for (let d = 0; d <= maxDepth; d++) {
    seSrc.push(new Uint32Array(seCountByDepth[d]!));
    seTgt.push(new Uint32Array(seCountByDepth[d]!));
  }
  const seCur = new Uint32Array(maxDepth + 1);
  for (let g = 0; g < size; g++) {
    const d = depth[g]!;
    const gs = slot[g]!;
    const src = seSrc[d]!;
    const tgt = seTgt[d]!;
    for (let e = superEdgeOffset[g]!; e < superEdgeOffset[g + 1]!; e++) {
      const pos = seCur[d]!;
      src[pos] = gs;
      tgt[pos] = slot[superEdgeTarget[e]!]!;
      seCur[d] = pos + 1;
    }
  }

  // ── 6. Top-down solve. Depth 0 = the root(s): a tiny CPU disc seed (roots are a handful for a module
  //       tree — the empty-prefix root — so this is not a per-level loop). Each deeper depth is GPU-seeded
  //       by prolongation from the one above, then solved (if within maxSeedNodes) on the GPU.
  const output = graph.positions;
  const prolongate = new ProlongatePass(device);
  const scratch = new Float32Array(maxLevel * 2); // reused readback buffer for solved levels

  const rootCount = depthCount[0]!;
  const rootPos = new Float32Array(rootCount * 2);
  seedPositions({ nodeCount: rootCount, edgeCount: 0, source: EMPTY_U32, target: EMPTY_U32, positions: rootPos }, width, height);
  const rootPack = packPositionsTexture(device, rootPos);

  // The "previous level" the next prolongation samples: either a standalone texture (root / a
  // prolongate-only level) or a live GpuForceLayout's position texture (a solved level).
  let prevTex: Texture = rootPack.texture;
  let prevWidth = rootPack.width;
  let prevLayout: GpuForceLayout | null = null;
  let prevOwnedTex: Texture | null = rootPack.texture;
  let prevOwnedFbo: Framebuffer | null = null;

  const maxStep = Math.max(width, height) * 4;

  /** Scatter this depth's leaf slots into `output` (leaves terminate here; never subdivided deeper). */
  const extractLeaves = (d: number, posArr: Float32Array): void => {
    for (let i = depthOffset[d]!; i < depthOffset[d + 1]!; i++) {
      const g = depthNodes[i]!;
      if (g < leafCount) {
        const s = i - depthOffset[d]!; // = slot[g]
        output[2 * g] = posArr[2 * s]!;
        output[2 * g + 1] = posArr[2 * s + 1]!;
      }
    }
  };

  for (let d = 1; d <= maxDepth; d++) {
    const count = depthCount[d]!;
    if (count === 0) continue;
    const cwidth = atlasWidth(count);

    // Upload this level's parent-slot + offset maps (packed by slot; atlas width == the position atlas).
    const o0 = depthOffset[d]!;
    const parentSlotPack = packUintTexture(device, parentSlotByDepth.subarray(o0, o0 + count));
    const offsetPack = packPositionsTexture(device, offsetByDepth.subarray(o0 * 2, (o0 + count) * 2));

    const seedRun = (pass: Parameters<ProlongatePass["run"]>[0]): void =>
      prolongate.run(pass, {
        parentPosTex: prevTex,
        parentSlotTex: parentSlotPack.texture,
        offsetTex: offsetPack.texture,
        count,
        width: cwidth,
        parentWidth: prevWidth,
      });

    let posArr: Float32Array;
    let thisTex: Texture;
    let thisWidth: number;
    let thisLayout: GpuForceLayout | null = null;
    let thisOwnedTex: Texture | null = null;
    let thisOwnedFbo: Framebuffer | null = null;

    if (count > 1 && count <= maxSeedNodes) {
      // Solve this level on the GPU (reuse the full force pipeline over its super-edge graph).
      const levelGraph: LayoutGraph = {
        nodeCount: count,
        edgeCount: seSrc[d]!.length,
        source: seSrc[d]!,
        target: seTgt[d]!,
        positions: new Float32Array(count * 2), // dummy; overwritten by the GPU prolongation seed
      };
      const layout = new GpuForceLayout(device, levelGraph, params, { maxStep });
      layout.seedFromProlongation((pass) => seedRun(pass));
      layout.runFrame(coarsenIterations);
      layout.readPositions(scratch);
      posArr = scratch;
      thisTex = layout.positionTexture;
      thisWidth = layout.positionWidth;
      thisLayout = layout;
    } else {
      // Prolongate-only: too large to solve (or a single node) — gather into a bare position texture,
      // no force machinery allocated. The finest refine handles this level's detail.
      const cheight = Math.ceil(count / cwidth);
      const posTex = device.createTexture({ width: cwidth, height: cheight, format: "rg32float", mipLevels: 1, sampler: { minFilter: "nearest", magFilter: "nearest" } });
      const fbo = device.createFramebuffer({ width: cwidth, height: cheight, colorAttachments: [posTex] });
      const pass = device.beginRenderPass({ framebuffer: fbo, clearColor: false });
      seedRun(pass);
      pass.end();
      device.submit();
      posArr = readbackFloatFboReuse(device, fbo, cwidth, count);
      thisTex = posTex;
      thisWidth = cwidth;
      thisOwnedTex = posTex;
      thisOwnedFbo = fbo;
    }

    extractLeaves(d, posArr);

    // Free this level's upload textures + the previous level's resources (past-prolongation now).
    parentSlotPack.texture.destroy();
    offsetPack.texture.destroy();
    if (prevLayout) prevLayout.destroy();
    if (prevOwnedTex) prevOwnedTex.destroy();
    if (prevOwnedFbo) prevOwnedFbo.destroy();

    prevTex = thisTex;
    prevWidth = thisWidth;
    prevLayout = thisLayout;
    prevOwnedTex = thisOwnedTex;
    prevOwnedFbo = thisOwnedFbo;
  }

  if (prevLayout) prevLayout.destroy();
  if (prevOwnedTex) prevOwnedTex.destroy();
  if (prevOwnedFbo) prevOwnedFbo.destroy();
  prolongate.destroy();
}
