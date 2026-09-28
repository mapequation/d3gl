/**
 * T7 for the Navigator's configuration (#353): LOD on with the default multilevel seed, whose plan and tree
 * the LOD relay's worker builds from one coarsening — the seed frames and the stream after them keep every
 * transport bound and signature. The legs and what they pin are in `_gpu-stream-harness.ts`; the disc-start
 * LOD leg and its worker baseline are `gpu-stream-lod-perf`.
 */
import { describeGpuStream } from "./_gpu-stream-harness.js";

describeGpuStream("LOD on, seeded");
