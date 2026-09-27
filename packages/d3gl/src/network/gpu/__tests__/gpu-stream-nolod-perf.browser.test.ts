/**
 * T7 with LOD off: the streaming GPU layout's per-frame guard over the full-detail draw — the stream
 * (transport bounds, async readback signatures, throughput against the GPU-only rate) and a node drag. The
 * legs and what they pin are in `_gpu-stream-harness.ts`; the LOD-on half is `gpu-stream-lod-perf`.
 */
import { describeGpuStream } from "./_gpu-stream-harness.js";

describeGpuStream("LOD off");
