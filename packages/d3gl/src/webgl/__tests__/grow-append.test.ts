import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the luma.gl modules the renderer imports. The renderer calls
// `new Model(device, props)`, `device.createBuffer`, `device.createTexture`, and
// reads `Buffer.INDEX`. We hand-roll fakes that RECORD the calls we assert on:
//   - FakeBuffer records write(data, byteOffset?) calls + tracks byteLength.
//   - FakeTexture records writeData calls.
//   - FakeModel records setVertexCount / setAttributes / setIndexBuffer / setBindings.
// A module-level `created` registry lets the test inspect every object made.
// ---------------------------------------------------------------------------

// vi.hoisted runs before vi.mock factories (which are hoisted to top of file), so the
// fake classes + the `created` registry exist when the factories reference them.
const { FakeBuffer, FakeTexture, FakeModel, created } = vi.hoisted(() => {
  interface WriteCall {
    length: number;
    byteOffset: number;
  }
  const created = {
    buffers: [] as InstanceType<typeof FakeBuffer>[],
    textures: [] as InstanceType<typeof FakeTexture>[],
    models: [] as InstanceType<typeof FakeModel>[],
  };
  class FakeBuffer {
    static INDEX = "index";
    byteLength: number;
    usage?: unknown;
    indexType?: string;
    writes: WriteCall[] = [];
    destroyed = false;
    constructor(props: { data?: ArrayBufferView; byteLength?: number; usage?: unknown; indexType?: string }) {
      this.byteLength = props.byteLength ?? (props.data ? props.data.byteLength : 0);
      this.usage = props.usage;
      this.indexType = props.indexType;
      created.buffers.push(this);
    }
    write(data: ArrayBufferView, byteOffset = 0): void {
      this.writes.push({ length: data.byteLength, byteOffset });
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  class FakeTexture {
    width: number;
    height: number;
    format?: string;
    writeDatas: { x: number; y: number; width: number; height: number; length: number }[] = [];
    destroyed = false;
    constructor(props: { width: number; height: number; format?: string }) {
      this.width = props.width;
      this.height = props.height;
      this.format = props.format;
      created.textures.push(this);
    }
    writeData(data: ArrayBufferView, region: { x: number; y: number; width: number; height: number }): void {
      this.writeDatas.push({ ...region, length: data.byteLength });
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  class FakeModel {
    vertexCount = 0;
    setAttributesCalls = 0;
    setIndexBufferCalls = 0;
    setBindingsCalls = 0;
    constructor(_device: unknown, _props: unknown) {
      created.models.push(this);
    }
    setVertexCount(n: number): void {
      this.vertexCount = n;
    }
    setAttributes(_b: unknown): void {
      this.setAttributesCalls++;
    }
    setIndexBuffer(_b: unknown): void {
      this.setIndexBufferCalls++;
    }
    setBindings(_b: unknown): void {
      this.setBindingsCalls++;
    }
    setParameters(_p: unknown): void {}
    draw(): void {}
    destroy(): void {}
  }
  return { FakeBuffer, FakeTexture, FakeModel, created };
});

vi.mock("@luma.gl/core", () => ({ Buffer: FakeBuffer }));
vi.mock("@luma.gl/engine", () => ({ Model: FakeModel }));
// Shaders are inert strings; import them as-is (no GPU compile in node).

const fakeDevice = {
  createBuffer: (props: ConstructorParameters<typeof FakeBuffer>[0]) => new FakeBuffer(props),
  createTexture: (props: { width: number; height: number; format?: string }) => new FakeTexture(props),
} as unknown as import("@luma.gl/core").Device;

// Import AFTER mocks are registered.
import { GroupRenderer } from "../renderer.js";
import type { GroupBuffers, GroupBufferDelta } from "../../core/index.js";

/** A points-only group with `n` circles, ids 0..n-1, each at (i, i) radius 1. */
function pointBuffers(n: number, from = 0): GroupBuffers {
  const pc = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pc[i * 4] = i;
    pc[i * 4 + 1] = i;
    pc[i * 4 + 2] = 1;
    pc[i * 4 + 3] = from + i;
  }
  const total = from + n;
  return {
    fillVertices: new Float32Array(0),
    fillIndices: new Uint32Array(0),
    strokeVertices: new Float32Array(0),
    strokeIndices: new Uint32Array(0),
    fillColors: new Uint8Array(total * 4).fill(255),
    strokeColors: new Uint8Array(total * 4),
    flags: new Uint8Array(total).fill(1),
    drawableCount: total,
    pointCenters: pc,
    pointCount: n,
    fillAnchors: new Float32Array(0),
    strokeAnchors: new Float32Array(0),
  };
}

/** A delta appending `n` point drawables starting at absolute index `from`. */
function pointDelta(n: number, from: number): GroupBufferDelta {
  const pc = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pc[i * 4] = from + i;
    pc[i * 4 + 1] = from + i;
    pc[i * 4 + 2] = 1;
    pc[i * 4 + 3] = from + i;
  }
  const total = from + n;
  return {
    fillVertices: new Float32Array(0),
    fillIndices: new Uint32Array(0),
    strokeVertices: new Float32Array(0),
    strokeIndices: new Uint32Array(0),
    fillColors: new Uint8Array(n * 4).fill(255),
    strokeColors: new Uint8Array(n * 4),
    flags: new Uint8Array(n).fill(1),
    pointCenters: pc,
    fillAnchors: new Float32Array(0),
    strokeAnchors: new Float32Array(0),
    drawableCount: total,
    fromDrawable: from,
  };
}

beforeEach(() => {
  created.buffers = [];
  created.textures = [];
  created.models = [];
});

describe("GrowBuffer / GroupRenderer.append — O(new) incremental upload", () => {
  it("appends within capacity via tail sub-data (no buffer recreation, vertexCount grows)", () => {
    // Seed with a few points. minCapacity is 256 elements, so a handful of small
    // appends stays well within capacity → tail writes, no realloc.
    const r = new GroupRenderer(fakeDevice, pointBuffers(2), 100, 100);

    // The point pass creates 5 GrowBuffers (center, corner, radius, pointId, index).
    const seedBuffers = created.buffers.length;
    expect(seedBuffers).toBeGreaterThanOrEqual(5);
    const pointModel = created.models[created.models.length - 1]!;
    // Seed draw count is passed via the Model constructor props, not setVertexCount,
    // so the recorded `vertexCount` field is still 0 until the first append bumps it.

    // The geometry buffers' write counts so far (initial seed write each).
    const geomBuffers = created.buffers.slice();

    // Append 3 more points — fits in capacity.
    r.append(pointDelta(3, 2));

    // No NEW buffers created for the geometry (within capacity → no realloc).
    expect(created.buffers.length).toBe(seedBuffers);

    // Each geometry GrowBuffer got a SECOND write at a non-zero byte offset (tail sub-data).
    // Find the index GrowBuffer (usage === INDEX) and a vertex one (center).
    const indexBuf = geomBuffers.find((b) => b.usage === FakeBuffer.INDEX)!;
    expect(indexBuf.writes.length).toBe(2); // seed + tail append
    expect(indexBuf.writes[1]!.byteOffset).toBeGreaterThan(0); // tail, not full re-upload

    const vertexBuf = geomBuffers.find((b) => b.usage !== FakeBuffer.INDEX)!;
    expect(vertexBuf.writes.length).toBe(2);
    expect(vertexBuf.writes[1]!.byteOffset).toBeGreaterThan(0);

    // Draw count set to all 5 circles now → 30 indices.
    expect(pointModel.vertexCount).toBe(5 * 6);
    expect(pointModel.vertexCount).toBe(30);
  });

  it("reallocates (capacity doubling) when an append exceeds capacity, rebinding the Model", () => {
    // Seed 1 point. minCapacity = 256 elements per GrowBuffer.
    const r = new GroupRenderer(fakeDevice, pointBuffers(1), 100, 100);
    const seedBufferCount = created.buffers.length;
    const pointModel = created.models[created.models.length - 1]!;
    const setAttrBefore = pointModel.setAttributesCalls;
    const setIdxBefore = pointModel.setIndexBufferCalls;

    // Append 200 points. Per circle: center 8 floats, corner 8, radius 4, pointId 4,
    // index 6. The index buffer holds 1*6 = 6 used of capacity 256; 200 more = 1206 > 256
    // → must reallocate. The center buffer: 1*8 used = 8 of 256; +200*8 = 1608 > 256 → realloc.
    r.append(pointDelta(200, 1));

    // At least one NEW geometry buffer was created (realloc). createTexture is unaffected.
    expect(created.buffers.length).toBeGreaterThan(seedBufferCount);

    // Model was rebound (new buffers): setAttributes + setIndexBuffer called.
    expect(pointModel.setAttributesCalls).toBe(setAttrBefore + 1);
    expect(pointModel.setIndexBufferCalls).toBe(setIdxBefore + 1);

    // Draw count reflects all 201 circles.
    expect(pointModel.vertexCount).toBe(201 * 6);

    // On realloc the index buffer was written with the FULL mirror (byteOffset 0),
    // not a tail offset. Find a freshly-created index buffer (created after seed).
    const newBuffers = created.buffers.slice(seedBufferCount);
    const newIndex = newBuffers.find((b) => b.usage === FakeBuffer.INDEX)!;
    expect(newIndex.writes.length).toBe(1);
    expect(newIndex.writes[0]!.byteOffset).toBe(0); // full re-upload of grown mirror
    expect(newIndex.writes[0]!.length).toBe(201 * 6 * 4); // 201*6 uint32 = bytes
  });

  it("grows the color/flags textures: partial writeData when dims unchanged, recreate when dims change", () => {
    // paletteDimensions: width = min(count, 256), height = ceil(count/width). So BELOW 256
    // every append widens the row → dims change → recreate. AT/ABOVE 256 width pins to 256
    // and only height changes, so appends within the same 256-row band keep dims equal →
    // partial writeData (no recreate). Seed above 256 to exercise the partial path.
    const r = new GroupRenderer(fakeDevice, pointBuffers(300), 100, 100);
    const seedTextures = created.textures.length; // 2 (color + flags), point owns them (no fill)
    const colorTex = created.textures[0]!;
    const pointModel = created.models[created.models.length - 1]!;
    const setBindingsBefore = pointModel.setBindingsCalls;
    expect(colorTex.height).toBe(2); // 300 -> width 256, height 2

    // Append 300 -> 400: still width 256, height 2 → dims UNCHANGED → partial writeData.
    r.append(pointDelta(100, 300));
    expect(created.textures.length).toBe(seedTextures); // no recreate
    expect(colorTex.writeDatas.length).toBeGreaterThan(0); // partial upload happened
    expect(pointModel.setBindingsCalls).toBe(setBindingsBefore); // no rebind

    // Append 400 -> 700: height grows to 3 → dims CHANGE → recreate + rebind.
    r.append(pointDelta(300, 400));
    expect(created.textures.length).toBeGreaterThan(seedTextures); // new textures created
    expect(pointModel.setBindingsCalls).toBe(setBindingsBefore + 1); // rebound to new textures
  });

  it("grows color/flags textures in O(new): few recreations + partial-row uploads across many 256-boundaries", () => {
    // Stream 2000 drawables as 20 appends of 100, crossing ~8 row boundaries (rows of 256).
    // The O(total) regression manifests two ways the fix must avoid:
    //   (a) recreating the texture on (nearly) every batch — old code recreates whenever
    //       paletteDimensions(count).height changes, i.e. every time count crosses a 256
    //       multiple (≈8 times here) AND the dims-unchanged branch still re-uploaded the
    //       FULL height each batch.
    //   (b) re-uploading the FULL texture height on every writeData (old dims-unchanged
    //       branch used { y: 0, height: fullHeight }).
    // The capacity-doubling GrowTexture: created once, then doubles rows 1→2→4→8→16 (4
    // extra recreations to reach 16 rows of capacity for 2050 drawables), and each
    // non-recreate upload touches only the changed rows (small height, y often > 0).
    const r = new GroupRenderer(fakeDevice, pointBuffers(50), 100, 100);
    // Points-only renderer: the point pass OWNS its color/flags textures.
    const colorTexturesInitial = created.textures.filter((t) => t.format === "rgba8unorm");
    expect(colorTexturesInitial.length).toBe(1); // one color table created at build

    let total = 50;
    for (let i = 0; i < 20; i++) {
      r.append(pointDelta(100, total));
      total += 100;
    }
    expect(total).toBe(2050);

    // (a) Color texture created FEW times — initial + log2 capacity doublings, NOT
    // once per batch (would be ~21) and NOT once per 256-boundary (would be ~9).
    const colorTextures = created.textures.filter((t) => t.format === "rgba8unorm");
    expect(colorTextures.length).toBeLessThanOrEqual(5);
    // And strictly fewer than the number of batches / the number of row boundaries.
    expect(colorTextures.length).toBeLessThan(9);

    // Gather every partial writeData across all color textures (different texture objects
    // get used as capacity doubles; the live one accumulates the rest).
    const allWrites = colorTextures.flatMap((t) => t.writeDatas);
    expect(allWrites.length).toBeGreaterThan(0);

    // (b) Uploads are PARTIAL rows, not full-height re-uploads:
    //   - At least one write starts at y > 0 (writing into a tail row, not the whole table).
    const someTailRow = allWrites.some((w) => w.y > 0);
    expect(someTailRow).toBe(true);
    //   - Every write covers only a few rows (height small), never the full live height.
    //     A 100-drawable delta spans at most 2 rows.
    const maxRows = Math.max(...allWrites.map((w) => w.height));
    expect(maxRows).toBeLessThanOrEqual(2);
    //   - Width stays fixed at 256 (the shader's id % width mapping relies on this).
    expect(allWrites.every((w) => w.width === 256)).toBe(true);
    //   - The largest live texture is 8 rows (nextPow2(ceil(2050/256)) = nextPow2(9) = 16),
    //     proving the table is NOT re-uploaded at its full height each batch.
    const liveColor = colorTextures[colorTextures.length - 1]!;
    expect(liveColor.height).toBe(16);
    // Total bytes uploaded by partial writes is O(new) — bounded well under
    // (batches × full-table bytes). Full re-upload each batch would be ≥ 20 * 2050 * 4.
    const totalBytes = allWrites.reduce((a, w) => a + w.length, 0);
    expect(totalBytes).toBeLessThan(20 * 2050 * 4 * 0.25);
  });

  it("returns false when a needed pass is absent (empty renderer), so the backend can rebuild", () => {
    // A layer created empty has all passes null. Appending point geometry can't grow a
    // null point pass → append() returns false. WebGLBackend uses this to rebuild from the
    // (fromDrawable===0) delta. Within a non-empty renderer of the same type it returns true.
    const empty: GroupBuffers = {
      fillVertices: new Float32Array(0), fillIndices: new Uint32Array(0),
      strokeVertices: new Float32Array(0), strokeIndices: new Uint32Array(0),
      fillColors: new Uint8Array(0), strokeColors: new Uint8Array(0), flags: new Uint8Array(0),
      drawableCount: 0, pointCenters: new Float32Array(0), pointCount: 0,
      fillAnchors: new Float32Array(0), strokeAnchors: new Float32Array(0),
    };
    const r = new GroupRenderer(fakeDevice, empty, 100, 100);
    expect(r.append(pointDelta(3, 0))).toBe(false); // point pass null → can't grow

    const r2 = new GroupRenderer(fakeDevice, pointBuffers(1), 100, 100);
    expect(r2.append(pointDelta(3, 1))).toBe(true); // pass exists → grown in place
  });

  it("multiple sequential appends keep cumulative draw count correct", () => {
    const r = new GroupRenderer(fakeDevice, pointBuffers(1), 100, 100);
    const pointModel = created.models[created.models.length - 1]!;
    let total = 1;
    for (const n of [3, 7, 20, 500]) {
      r.append(pointDelta(n, total));
      total += n;
      expect(pointModel.vertexCount).toBe(total * 6);
    }
  });
});
