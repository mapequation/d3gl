import { Model } from "@luma.gl/engine";
import type { Buffer, Device, RenderPass, Texture } from "@luma.gl/core";
import { INDEXED_LINE_VS, INDEXED_ARROW_VS, INDEXED_HALF_ARROW_VS, FILL_FS, PICK_FS } from "./shaders.js";
import { clipFromView } from "./transform.js";
import { ARROW_TEMPLATE, HALF_ARROW_TEMPLATE, HALF_ARROW_SAMPLES, halfArrowTemplate, lineTemplate } from "./instanced.js";
import type { InstancedLinesData, InstancedArrowsData, InstancedHalfArrowsData, InstancedHighlight } from "../core/index.js";

/**
 * **Indexed link draws** (#447): the link primitives (lines, arrowheads, half-arrows) drawn from per-edge
 * tables resident on the GPU, one instance per listed edge.
 *
 * The attribute primitives (`instanced.ts`) take one array entry per drawn instance, so a caller that shows a
 * changing subset of a fixed edge set rebuilds and re-uploads every column per frame. Here the style columns
 * (widths, bends, radii, sizes, colours, highlight groups, selection) are per-**edge** tables of `tableCount`
 * entries, packed into textures (edge `e` at texel `(e % width, e / width)`) and re-uploaded only when one of
 * their source arrays is a different object than last time (the same reference-identity rule as
 * `writeIfChanged`: a handed-out table is never mutated in place). What stays per instance is what changes
 * with the view or the layout: the edge id (4 B), the two ends (16 B, which the layout moves in place, so a
 * table of them would be re-packed for every edge on every layout frame) and an optional fade (4 B). A frame
 * uploads 20-24 B per drawn edge and draws `count` instances: GPU work and upload are O(shown edges). GPU
 * memory, per edge, once: the tables' 16-32 B of style, 4 B of colour and 1 B of selection, and the
 * per-instance lanes' 24 B, sized for every edge so the list never grows them (no GPU object is created while
 * it changes). The CPU keeps no copy of the tables, and 4 B per edge of ones for the fade lane. The vertex
 * shaders are the attribute ones with the style inputs fetched from the tables (`indexedVS` in shaders.ts), so
 * both draw the same geometry; the pick id is the edge id.
 */

/**
 * What every indexed link draw has uploaded, cumulative, for the per-frame guards (#447): bytes written to the
 * per-edge tables and the tables (re)built (the style: once per style, never per frame), bytes written to the
 * per-instance lanes (20-24 B per drawn edge on a frame that changed them), and the instances and count of the
 * draws set up (`draws`: one per indexed layer per emit).
 */
export const indexedLinkStats = { tableBytes: 0, tablesBuilt: 0, instanceBytes: 0, instances: 0, draws: 0 };

/** Texels per table row: the tables are `width × rows`, `rows` ≤ the device's largest texture side. */
const TABLE_WIDTH = 4096;

type TableFormat = "rgba32float" | "rgba8unorm" | "r8unorm";

/** One per-edge table: the uniform it binds to, its texel format, the source arrays it is packed from (the
 *  upload skips while every one is the same object), and the packer that writes `rows × width` texels. */
interface TableSpec {
  name: string;
  format: TableFormat;
  refs: readonly unknown[];
  pack: (out: Float32Array | Uint8Array, n: number) => void;
}

const CHANNELS: Record<TableFormat, number> = { rgba32float: 4, rgba8unorm: 4, r8unorm: 1 };

interface Table {
  texture: Texture;
  format: TableFormat;
  refs: readonly unknown[];
}

/** A table's texels for `rows × width` entries, packed afresh (never retained: the texture holds them). */
function texels(format: TableFormat, entries: number): Float32Array | Uint8Array {
  const size = entries * CHANNELS[format];
  return format === "rgba32float" ? new Float32Array(size) : new Uint8Array(size);
}

function sameRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** One per-instance lane: a buffer with room for `capacity` instances and the array last written to it. */
interface Lane {
  buffer: Buffer;
  last: Float32Array | undefined;
}

/** The shared draw: the edge tables, the per-instance lanes (edge id, the two ends, fade), and the fill (+ pick) models. */
class IndexedLinkDraw {
  count: number;
  /** Instances the per-instance lanes have room for: every edge of the table, grown (at least doubled) only with it. */
  capacity: number;
  /** Edges the tables have room for (`width × rows`). */
  private tableCapacity: number;
  private readonly width: number;
  private rows: number;
  private lanes: Record<string, Lane>;
  /** Leading instances whose fade lane holds 1 (no cross-fade band): the lane is written only to draw past them. */
  private opaque = 0;
  private tables = new Map<string, Table>();
  readonly uniforms: Record<string, unknown>;
  private model: Model;
  private pickModel?: Model;

  constructor(
    private readonly device: Device,
    private readonly shape: { vs: string; template: Buffer; templateName: string; ends: readonly [string, string]; vertexCount: number; topology: "triangle-strip" | "triangle-list" },
    inst: Instances,
    tableCount: number,
    specs: TableSpec[],
    width: number,
    height: number,
    pick: boolean,
  ) {
    const max = device.limits.maxTextureDimension2D;
    this.width = Math.min(TABLE_WIDTH, max);
    this.rows = Math.max(1, Math.ceil(tableCount / this.width));
    if (this.rows > max) throw new Error(`an indexed link draw holds at most ${this.width * max} edges, not ${tableCount}`);
    this.tableCapacity = this.rows * this.width;
    this.count = inst.count;
    indexedLinkStats.instances += inst.count;
    indexedLinkStats.draws++;
    // Room for every edge: the lanes never grow while the list changes (only with a larger edge set).
    this.capacity = Math.max(1, inst.count, tableCount);
    this.lanes = this.makeLanes(inst);
    for (const spec of specs) this.tables.set(spec.name, this.makeTable(spec, tableCount));
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width || 1, height || 1],
      u_pickBase: 0,
      u_hoverGroup: -1,
      u_dimActive: 0,
      u_dimOpacity: 1,
      u_recolor: 1, // links recolour toward the highlight hue
      u_recolorRGB: [0.863, 0.149, 0.149],
    };
    this.model = this.makeModel(FILL_FS, BLEND);
    if (pick) this.pickModel = this.makeModel(PICK_FS, NO_BLEND);
  }

  /** The per-instance lanes at `capacity`, holding `inst` (the fade lane all ones when `inst.fade` is absent). */
  private makeLanes(inst: Instances): Record<string, Lane> {
    const [s, t] = this.shape.ends;
    const lane = (data: Float32Array | undefined, floats: number, fill?: number): Lane => {
      const buffer = this.device.createBuffer({ byteLength: 4 * floats * this.capacity });
      const src = data ?? (fill !== undefined ? this.opaqueOnes(inst.count) : undefined);
      if (src && inst.count > 0) {
        buffer.write(src.subarray(0, floats * inst.count));
        indexedLinkStats.instanceBytes += 4 * floats * inst.count;
      }
      return { buffer, last: data };
    };
    this.opaque = inst.fade ? 0 : inst.count;
    return { a_edge: lane(inst.index, 1), [s]: lane(inst.sources, 2), [t]: lane(inst.targets, 2), a_fade: lane(inst.fade, 1, 1) };
  }

  /** A retained array of at least `n` ones, the fade lane's source outside a cross-fade band. */
  private opaqueOnes(n: number): Float32Array {
    if (this.ones.length < n) this.ones = new Float32Array(this.capacity).fill(1);
    return this.ones;
  }
  private ones = new Float32Array(0);

  private laneBuffers(): Record<string, Buffer> {
    const out: Record<string, Buffer> = {};
    for (const [name, l] of Object.entries(this.lanes)) out[name] = l.buffer;
    return out;
  }

  private makeTable(spec: TableSpec, n: number): Table {
    const data = texels(spec.format, this.tableCapacity);
    spec.pack(data, n);
    indexedLinkStats.tablesBuilt++;
    indexedLinkStats.tableBytes += data.byteLength;
    const texture = this.device.createTexture({
      data,
      width: this.width,
      height: this.rows,
      format: spec.format,
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
    return { texture, format: spec.format, refs: spec.refs };
  }

  private bindings(): Record<string, Texture> {
    const out: Record<string, Texture> = {};
    for (const [name, t] of this.tables) out[name] = t.texture;
    return out;
  }

  private makeModel(fs: string, parameters: typeof BLEND | typeof NO_BLEND): Model {
    return new Model(this.device, {
      vs: this.shape.vs,
      fs,
      bufferLayout: [
        { name: this.shape.templateName, format: "float32x2" },
        { name: "a_edge", format: "float32", stepMode: "instance" },
        { name: this.shape.ends[0], format: "float32x2", stepMode: "instance" },
        { name: this.shape.ends[1], format: "float32x2", stepMode: "instance" },
        { name: "a_fade", format: "float32", stepMode: "instance" },
      ],
      attributes: { [this.shape.templateName]: this.shape.template, ...this.laneBuffers() },
      bindings: this.bindings(),
      uniforms: this.uniforms,
      parameters,
      topology: this.shape.topology,
      vertexCount: this.shape.vertexCount,
      instanceCount: this.count,
    });
  }

  /** Draw `inst.count` edges of `inst.index`, from tables re-packed only where a source array changed. Every
   *  per-instance lane skips its upload while its array is the same object as last time. */
  update(inst: Instances, tableCount: number, specs: TableSpec[]): void {
    let rebind = false;
    if (tableCount > this.tableCapacity) {
      // A larger edge set (new data): reallocate every table at the new size, once.
      this.rows = Math.max(1, Math.ceil(tableCount / this.width));
      const max = this.device.limits.maxTextureDimension2D;
      if (this.rows > max) throw new Error(`an indexed link draw holds at most ${this.width * max} edges, not ${tableCount}`);
      this.tableCapacity = this.rows * this.width;
      for (const t of this.tables.values()) t.texture.destroy();
      this.tables.clear();
      for (const spec of specs) this.tables.set(spec.name, this.makeTable(spec, tableCount));
      rebind = true;
    } else {
      for (const spec of specs) {
        const t = this.tables.get(spec.name);
        if (!t) continue;
        if (sameRefs(t.refs, spec.refs)) continue;
        const usedRows = Math.max(1, Math.ceil(tableCount / this.width));
        const packed = texels(spec.format, usedRows * this.width);
        spec.pack(packed, tableCount);
        t.texture.writeData(packed, { x: 0, y: 0, width: this.width, height: usedRows });
        indexedLinkStats.tableBytes += packed.byteLength;
        t.refs = spec.refs;
      }
    }
    const count = inst.count;
    if (count > this.capacity || tableCount > this.capacity) {
      this.capacity = Math.max(count, tableCount, 2 * this.capacity);
      for (const l of Object.values(this.lanes)) l.buffer.destroy();
      this.lanes = this.makeLanes(inst);
      const attributes = this.laneBuffers();
      this.model.setAttributes(attributes);
      this.pickModel?.setAttributes(attributes);
    } else {
      const [s, t] = this.shape.ends;
      this.writeLane("a_edge", inst.index, count, 1);
      this.writeLane(s, inst.sources, count, 2);
      this.writeLane(t, inst.targets, count, 2);
      const fade = this.lanes["a_fade"];
      if (fade && inst.fade) {
        this.writeLane("a_fade", inst.fade, count, 1);
        this.opaque = 0;
      } else if (fade && this.opaque < count) {
        // No band, and this frame draws instances whose fade is not 1 yet: write ones up to `count`.
        fade.buffer.write(this.opaqueOnes(count).subarray(0, count));
        indexedLinkStats.instanceBytes += 4 * count;
        fade.last = undefined;
        this.opaque = count;
      }
    }
    if (rebind) {
      this.model.setBindings(this.bindings());
      this.pickModel?.setBindings(this.bindings());
    }
    this.count = count;
    indexedLinkStats.instances += count;
    indexedLinkStats.draws++;
    this.model.setInstanceCount(count);
    this.pickModel?.setInstanceCount(count);
  }

  private writeLane(name: string, data: Float32Array, count: number, floats: number): void {
    const l = this.lanes[name];
    if (!l || l.last === data) return;
    if (count > 0) {
      l.buffer.write(data.subarray(0, floats * count));
      indexedLinkStats.instanceBytes += 4 * floats * count;
    }
    l.last = data;
  }

  /** Rewrite the per-edge selected table from a 0/1 flag per edge (a selection change: no geometry touch). */
  writeSelected(selected: Uint8Array, tableCount: number): void {
    const t = this.tables.get("u_edgeSelected");
    if (!t || t.refs[0] === selected) return; // the same flags (a fresh array on every selection change)
    const n = Math.min(tableCount, selected.length);
    const usedRows = Math.max(1, Math.ceil(tableCount / this.width));
    const flags = new Uint8Array(usedRows * this.width);
    for (let e = 0; e < n; e++) flags[e] = selected[e] ? 1 : 0;
    t.texture.writeData(flags, { x: 0, y: 0, width: this.width, height: usedRows });
    indexedLinkStats.tableBytes += usedRows * this.width;
    t.refs = [selected];
  }

  render(pass: RenderPass): void {
    if (this.count > 0) this.model.draw(pass);
  }
  renderPick(pass: RenderPass): void {
    if (this.pickModel && this.count > 0) this.pickModel.draw(pass);
  }
  destroy(): void {
    this.model.destroy();
    this.pickModel?.destroy();
    for (const l of Object.values(this.lanes)) l.buffer.destroy();
    for (const t of this.tables.values()) t.texture.destroy();
    this.tables.clear();
  }
}

const BLEND = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one-minus-src-alpha",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;
const NO_BLEND = { blend: false } as const;

/** Pack per-edge columns into an rgba32float table: channel `c` of edge `e` from `cols[c]` (`stride` values
 *  per edge, value `offset` of them), or `fallback[c]` where a column is absent. */
function packRGBA(out: Float32Array | Uint8Array, n: number, cols: readonly (readonly [ArrayLike<number> | undefined, number, number] | null)[], fallback: readonly number[]): void {
  for (let c = 0; c < 4; c++) {
    const col = cols[c];
    const src = col?.[0];
    if (!col || !src) {
      const v = fallback[c] ?? 0;
      for (let e = 0; e < n; e++) out[4 * e + c] = v;
      continue;
    }
    const [, stride, offset] = col;
    for (let e = 0; e < n; e++) out[4 * e + c] = src[stride * e + offset] ?? 0;
  }
}

function colorSpec(colors: Uint8Array): TableSpec {
  return { name: "u_edgeColor", format: "rgba8unorm", refs: [colors], pack: (out, n) => out.set(colors.subarray(0, 4 * n)) };
}

function selectedSpec(selected: Uint8Array | undefined): TableSpec {
  return {
    name: "u_edgeSelected",
    format: "r8unorm",
    refs: [selected],
    pack: (out, n) => {
      if (!selected) out.fill(0, 0, n);
      else for (let e = 0; e < n; e++) out[e] = selected[e] ? 1 : 0;
    },
  };
}

function lineSpecs(d: InstancedLinesData): TableSpec[] {
  return [
    {
      name: "u_edgeStyle0",
      format: "rgba32float",
      refs: [d.widths, d.bends, d.groups, d.groups2],
      pack: (out, n) => packRGBA(out, n, [[d.widths, 1, 0], [d.bends, 1, 0], [d.groups, 1, 0], [d.groups2, 1, 0]], [0, 0, -1, -1]),
    },
    colorSpec(d.colors),
    selectedSpec(d.selected),
  ];
}

function arrowSpecs(d: InstancedArrowsData): TableSpec[] {
  return [
    {
      name: "u_edgeStyle0",
      format: "rgba32float",
      refs: [d.sizes, d.radii, d.bends, d.groups],
      pack: (out, n) => packRGBA(out, n, [[d.sizes, 1, 0], [d.radii, 1, 0], [d.bends, 1, 0], [d.groups, 1, 0]], [0, 0, 0, -1]),
    },
    { name: "u_edgeStyle1", format: "rgba32float", refs: [d.groups2], pack: (out, n) => packRGBA(out, n, [[d.groups2, 1, 0], null, null, null], [-1, 0, 0, 0]) },
    colorSpec(d.colors),
    selectedSpec(d.selected),
  ];
}

function halfArrowSpecs(d: InstancedHalfArrowsData): TableSpec[] {
  return [
    {
      name: "u_edgeStyle0",
      format: "rgba32float",
      refs: [d.radii, d.widths],
      pack: (out, n) => packRGBA(out, n, [[d.radii, 2, 0], [d.radii, 2, 1], [d.widths, 2, 0], [d.widths, 2, 1]], []),
    },
    {
      name: "u_edgeStyle1",
      format: "rgba32float",
      refs: [d.bends, d.groups, d.groups2],
      pack: (out, n) => packRGBA(out, n, [[d.bends, 1, 0], [d.groups, 1, 0], [d.groups2, 1, 0], null], [0, -1, -1, 0]),
    },
    colorSpec(d.colors),
    selectedSpec(d.selected),
  ];
}

/** The common surface of the three indexed primitives (the backend's link-renderer interface). */
abstract class IndexedLinks {
  protected abstract readonly draw: IndexedLinkDraw;
  protected abstract readonly template: Buffer;
  protected tableCount: number;
  constructor(tableCount: number) {
    this.tableCount = tableCount;
  }
  get count(): number {
    return this.draw.count;
  }
  get capacity(): number {
    return this.draw.capacity;
  }
  setTransform(m: Float32Array): void {
    this.draw.uniforms["u_transform"] = m;
  }
  setViewport(width: number, height: number): void {
    this.draw.uniforms["u_viewport"] = [width, height];
  }
  setSizeMode(mode: "world" | "screen"): void {
    this.draw.uniforms["u_screen"] = mode === "screen" ? 1 : 0;
  }
  setPickBase(base: number): void {
    this.draw.uniforms["u_pickBase"] = base;
  }
  setHighlight(h: InstancedHighlight): void {
    const u = this.draw.uniforms;
    if (h.hoverGroup !== undefined) u["u_hoverGroup"] = h.hoverGroup;
    if (h.dimActive !== undefined) u["u_dimActive"] = h.dimActive ? 1 : 0;
    if (h.dimOpacity !== undefined) u["u_dimOpacity"] = h.dimOpacity;
    if (h.recolor !== undefined) {
      u["u_recolor"] = h.recolor ? 1 : 0;
      if (h.recolor) u["u_recolorRGB"] = h.recolor;
    }
    // Per-edge flags for an indexed draw (the selection of the edges, not of the listed instances).
    if (h.selected) this.draw.writeSelected(h.selected, this.tableCount);
  }
  render(pass: RenderPass): void {
    this.draw.render(pass);
  }
  renderPick(pass: RenderPass): void {
    this.draw.renderPick(pass);
  }
  destroy(): void {
    this.draw.destroy();
    this.template.destroy();
  }
}

/** The per-instance part of an indexed draw: the listed edges, their ends, and the optional fade. */
interface Instances {
  index: Float32Array;
  sources: Float32Array;
  targets: Float32Array;
  fade?: Float32Array;
  count: number;
}

function instancesOf(d: { index?: Float32Array; tableCount?: number; sources: Float32Array; targets: Float32Array; fade?: Float32Array; count: number }): { inst: Instances; tableCount: number } {
  const index = d.index;
  if (!index) throw new Error("an indexed link draw needs `index`");
  return { inst: { index, sources: d.sources, targets: d.targets, fade: d.fade, count: d.count }, tableCount: d.tableCount ?? d.count };
}

/** Lines drawn by edge id ({@link IndexedLinkDraw}); `samples` is fixed per instance (a change recreates). */
export class IndexedLines extends IndexedLinks {
  protected readonly draw: IndexedLinkDraw;
  protected readonly template: Buffer;
  private readonly samples: number;
  constructor(device: Device, data: InstancedLinesData, width = 0, height = 0, pick = false) {
    const { inst, tableCount } = instancesOf(data);
    super(tableCount);
    this.samples = Math.max(2, (data.samples ?? 2) | 0);
    this.template = device.createBuffer({ data: lineTemplate(this.samples) });
    this.draw = new IndexedLinkDraw(device, { vs: INDEXED_LINE_VS, template: this.template, templateName: "a_corner", ends: ["a_source", "a_target"], vertexCount: this.samples * 2, topology: "triangle-strip" }, inst, tableCount, lineSpecs(data), width, height, pick);
  }
  /** `false` when the data is not indexed or its sample count changed: the caller recreates. */
  update(_device: Device, data: InstancedLinesData): boolean {
    if (!data.index || Math.max(2, (data.samples ?? 2) | 0) !== this.samples) return false;
    const { inst, tableCount } = instancesOf(data);
    this.tableCount = tableCount;
    this.draw.update(inst, tableCount, lineSpecs(data));
    return true;
  }
}

/** Arrowheads drawn by edge id; the `half` flag is fixed per instance (a change recreates). */
export class IndexedArrows extends IndexedLinks {
  protected readonly draw: IndexedLinkDraw;
  protected readonly template: Buffer;
  private readonly half: boolean;
  constructor(device: Device, data: InstancedArrowsData, width = 0, height = 0, pick = false) {
    const { inst, tableCount } = instancesOf(data);
    super(tableCount);
    this.half = !!data.half;
    this.template = device.createBuffer({ data: this.half ? HALF_ARROW_TEMPLATE : ARROW_TEMPLATE });
    this.draw = new IndexedLinkDraw(device, { vs: INDEXED_ARROW_VS, template: this.template, templateName: "a_tri", ends: ["a_source", "a_target"], vertexCount: 3, topology: "triangle-list" }, inst, tableCount, arrowSpecs(data), width, height, pick);
  }
  update(_device: Device, data: InstancedArrowsData): boolean {
    if (!data.index || !!data.half !== this.half) return false;
    const { inst, tableCount } = instancesOf(data);
    this.tableCount = tableCount;
    this.draw.update(inst, tableCount, arrowSpecs(data));
    return true;
  }
}

/** Half-arrows drawn by edge id; `samples` is fixed per instance (a change recreates). */
export class IndexedHalfArrows extends IndexedLinks {
  protected readonly draw: IndexedLinkDraw;
  protected readonly template: Buffer;
  private readonly samples: number;
  constructor(device: Device, data: InstancedHalfArrowsData, width = 0, height = 0, pick = false) {
    const { inst, tableCount } = instancesOf(data);
    super(tableCount);
    this.samples = Math.max(2, (data.samples ?? HALF_ARROW_SAMPLES) | 0);
    const template = halfArrowTemplate(this.samples);
    this.template = device.createBuffer({ data: template });
    this.draw = new IndexedLinkDraw(device, { vs: INDEXED_HALF_ARROW_VS, template: this.template, templateName: "a_kind", ends: ["a_p0", "a_p1"], vertexCount: template.length / 2, topology: "triangle-list" }, inst, tableCount, halfArrowSpecs(data), width, height, pick);
  }
  update(_device: Device, data: InstancedHalfArrowsData): boolean {
    if (!data.index || Math.max(2, (data.samples ?? HALF_ARROW_SAMPLES) | 0) !== this.samples) return false;
    const { inst, tableCount } = instancesOf(data);
    this.tableCount = tableCount;
    this.draw.update(inst, tableCount, halfArrowSpecs(data));
    return true;
  }
}
