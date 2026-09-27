/**
 * T7 with LOD on (the Navigator's structural cut, declutter, super-edges): the streaming GPU layout's
 * per-frame guard over the LOD frontier — the stream and a node drag. The legs and what they pin are in
 * `_gpu-stream-harness.ts`; the LOD-off half is `gpu-stream-nolod-perf`.
 */
import { describeGpuStream } from "./_gpu-stream-harness.js";

describeGpuStream("LOD on");
