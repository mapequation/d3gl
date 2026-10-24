import { Model } from "@luma.gl/engine";
import type { Buffer, Device, RenderPass } from "@luma.gl/core";
import { INSTANCED_CIRCLE_VS, INSTANCED_CIRCLE_FS, INSTANCED_PIE_VS, INSTANCED_PIE_FS, INSTANCED_LINE_VS, INSTANCED_HEAD_LINE_VS, INSTANCED_ARROW_VS, INSTANCED_HALF_ARROW_VS, POINT_FS, FILL_FS, PICK_FS } from "./shaders.js";
import { clipFromView } from "./transform.js";
import type { InstancedCirclesData, InstancedPieData, InstancedLinesData, InstancedArrowsData, InstancedHalfArrowsData, InstancedHighlight } from "../core/index.js";

/** Per-instance data carrying the shader-highlight columns (#162) — every instanced data type has these.
 *  `groups2` is the link's OTHER endpoint (target), so an undirected hover matches incident links on either
 *  side; `-1`/absent ⇒ unused (nodes, directed links match on `groups`/source alone). */
interface WithHighlight { groups?: Float32Array; groups2?: Float32Array; selected?: Uint8Array; count: number }

/** `-1`-filled `count`-length array — the default `a_group2` (an id never matched by a real group id). */
function minusOnes(count: number): Float32Array {
  return new Float32Array(count).fill(-1);
}

/** `a_selected` as float32 (the attribute format), from the engine's 0/1 `Uint8Array` (or all-zeros). */
function selectedFloats(data: WithHighlight): Float32Array {
  const out = new Float32Array(data.count);
  const sel = data.selected;
  if (sel) for (let i = 0; i < data.count && i < sel.length; i++) out[i] = sel[i]! > 0 ? 1 : 0;
  return out;
}

/**
 * The capacity (in instances) a lane grows to when an update's `count` outgrows its `capacity`: at least
 * double. An LOD frontier keeps growing while a layout expands or a zoom deepens; an exact fit reallocated
 * every buffer of the lane on each frame that set a new high, and doubling bounds the reallocations to
 * log2(peak / first) over the lane's life, like the Scene path's `GrowBuffer` (renderer.ts). A shrink
 * keeps the room (the tail past `count` is never drawn). The network's highlight lane tracks its layers' room
 * with it (#478).
 */
export function grownCapacity(count: number, capacity: number): number {
  return Math.max(count, 2 * capacity);
}

/** A per-instance buffer with room for `capacity` (≥ `count`) instances, holding `data` (`count` instances) from instance 0. */
function grownBuffer(device: Device, data: ArrayBufferView, count: number, capacity: number): Buffer {
  if (capacity <= count) return device.createBuffer({ data });
  const buffer = device.createBuffer({ byteLength: Math.ceil(data.byteLength / count) * capacity });
  buffer.write(data);
  return buffer;
}

/** Highlight tint (0..1) ≈ #dc2626 — the red the selection/hover rings use (#162), so a recoloured link
 *  matches its ring. The shader scales this by the instance's luminance, so weight-encoded links keep their cue. */
const HL_RED: [number, number, number] = [0.863, 0.149, 0.149];

/** Default highlight uniforms: no hover, no dim; `recolor` = 1 tints highlighted instances (links), 0 keeps (nodes). */
function highlightUniforms(recolor: 0 | 1): Record<string, unknown> {
  return { u_hoverGroup: -1, u_hoverInstances: [0, 0], u_dimActive: 0, u_dimOpacity: 1, u_recolor: recolor, u_recolorRGB: HL_RED };
}

/**
 * The two per-instance shader-highlight buffers (#162) — `a_group` (node/source id) + `a_selected`
 * (0/1 as float) — shared by all four instanced primitives. Built once with the geometry; a hover is a
 * uniform change (see {@link applyHighlight}), a selection change rewrites only `selected` ({@link writeSelected}),
 * so neither rebuilds geometry. Merge {@link layout}/{@link attributes} into the Model.
 */
class HighlightBuffers {
  group: Buffer;
  group2: Buffer;
  selected: Buffer;
  /** Last-uploaded group column references (#214) — the reference-identity upload skip (see
   *  {@link writeIfChanged}): the network's no-LOD cache reuses the SAME group array objects across
   *  position-only frames (never mutated in place), so their redundant per-frame re-upload is skipped;
   *  per-emit columns (LOD frontier) are fresh references and always upload. */
  private lastGroups: Float32Array | undefined;
  private lastGroups2: Float32Array | undefined;
  /** Last-uploaded selected-flag reference (#240) — the same skip for `a_selected`: the network's
   *  no-LOD flags are cached per selection version (a selection change hands back a FRESH array), so a
   *  position-only frame skips their O(count) float conversion + upload. Kept coherent by every path
   *  that uploads flags (constructor / {@link recreate} / {@link write} / {@link writeSelected}). */
  private lastSelected: Uint8Array | undefined;
  constructor(private device: Device, data: WithHighlight) {
    // Default group = -1 (an id no real node has), so a layer WITHOUT groups (plot points, aggregate
    // halos) never matches a hovered group id and never spuriously highlights.
    this.group = device.createBuffer({ data: data.groups ?? minusOnes(data.count) });
    this.group2 = device.createBuffer({ data: data.groups2 ?? minusOnes(data.count) });
    this.selected = device.createBuffer({ data: selectedFloats(data) });
    this.lastGroups = data.groups;
    this.lastGroups2 = data.groups2;
    this.lastSelected = data.selected; // a fresh registration uploads via createBuffer above
  }
  layout = [
    { name: "a_group", format: "float32" as const, stepMode: "instance" as const },
    { name: "a_group2", format: "float32" as const, stepMode: "instance" as const },
    { name: "a_selected", format: "float32" as const, stepMode: "instance" as const },
  ];
  attributes(): Record<string, Buffer> {
    return { a_group: this.group, a_group2: this.group2, a_selected: this.selected };
  }
  /** Reallocate the buffers at the lane's grown `capacity` on a geometry grow (every primitive's update
   *  path), holding `data`. Returns the fresh attributes to re-bind. */
  recreate(data: WithHighlight, capacity: number): Record<string, Buffer> {
    this.group.destroy();
    this.group2.destroy();
    this.selected.destroy();
    this.group = grownBuffer(this.device, data.groups ?? minusOnes(data.count), data.count, capacity);
    this.group2 = grownBuffer(this.device, data.groups2 ?? minusOnes(data.count), data.count, capacity);
    this.selected = grownBuffer(this.device, selectedFloats(data), data.count, capacity);
    this.lastGroups = data.groups;
    this.lastGroups2 = data.groups2;
    this.lastSelected = data.selected;
    return this.attributes();
  }
  /** Rewrite the buffers from fresh emit data (the in-place sub-update path). Every column skips when
   *  its array reference is unchanged: group columns per #214, `selected` per #240 (the no-LOD
   *  position-only fast path, like #179's style attrs — a selection change hands a fresh array, so an
   *  unchanged reference ⟺ unchanged flags). A defined→undefined `selected` transition still rewrites
   *  (zero-fills), so dropping the flags clears stale selection state. */
  write(data: WithHighlight): void {
    if (data.groups) this.lastGroups = writeIfChanged(this.group, data.groups, this.lastGroups);
    if (data.groups2) this.lastGroups2 = writeIfChanged(this.group2, data.groups2, this.lastGroups2);
    if (data.selected !== this.lastSelected) {
      this.selected.write(selectedFloats(data));
      this.lastSelected = data.selected;
    }
  }
  /** Rewrite ONLY the selected flags (a selection change) — no geometry touch. Records the array as
   *  last-uploaded (#240) so the next emit's {@link write} skips re-uploading the same flags. */
  writeSelected(selected: Uint8Array, count: number): void {
    this.selected.write(selectedFloats({ selected, count }));
    this.lastSelected = selected;
  }
  destroy(): void {
    this.group.destroy();
    this.group2.destroy();
    this.selected.destroy();
  }
}

/** Apply an {@link InstancedHighlight} to a uniforms record (only the provided fields). */
function applyHighlight(uniforms: Record<string, unknown>, h: InstancedHighlight): void {
  if (h.hoverGroup !== undefined) uniforms["u_hoverGroup"] = h.hoverGroup;
  if (h.hoverInstances !== undefined) uniforms["u_hoverInstances"] = h.hoverInstances;
  if (h.dimActive !== undefined) uniforms["u_dimActive"] = h.dimActive ? 1 : 0;
  if (h.dimOpacity !== undefined) uniforms["u_dimOpacity"] = h.dimOpacity;
  if (h.recolor !== undefined) {
    uniforms["u_recolor"] = h.recolor ? 1 : 0;
    if (h.recolor) uniforms["u_recolorRGB"] = h.recolor;
  }
}

/**
 * GPU-instanced primitives for the network module's rendering lane (#100, epic #98).
 *
 * Unlike the retained `Scene`/`GroupRenderer` path (quad-expanded points,
 * tessellated paths), this draws directly from columnar SoA instance buffers via
 * true GPU instancing — one instance per primitive, a shared unit-quad template.
 * It's the shared lane the network engine renders through; `plot.points()` migrates
 * onto it later (#108).
 */

/** Unit-quad corners as a triangle-strip (shared across all instances). */
const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

/** Standard premultiplied-over alpha blending (matches the pass-through path). */
const BLEND = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one-minus-src-alpha",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

/**
 * Pick-pass parameters (#141): blending OFF so each fragment writes its instance's encoded id
 * exactly (a blended id is a meaningless colour). No depth ⇒ the last-drawn instance wins a shared
 * pixel, mirroring the fill pass's painter order, so the GPU readback resolves the topmost link.
 */
const NO_BLEND = { blend: false } as const;

/**
 * Reference-identity upload skip (#179): `bufferSubData` `arr` into `buffer` ONLY when it is a
 * *different array object* from `last`. Returns the reference to store as the new `last`.
 *
 * The network's style cache reuses the SAME colour/width/radius array objects across position-only
 * layout frames (reference-stable ⟺ content-stable — the cached arrays are never mutated in place),
 * while the endpoint/position arrays are freshly allocated each frame (new reference). So a
 * same-reference style array skips its redundant per-frame upload, and a fresh position array always
 * uploads. On a style change the cache produces a *new* array (new reference), which uploads. This is
 * safe ONLY under that invariant — the caller must never mutate a retained array in place.
 */
function writeIfChanged<T extends ArrayBufferView>(buffer: Buffer, arr: T, last: T | undefined): T {
  if (arr !== last) buffer.write(arr);
  return arr;
}

/** Pie-lane column uploads (#507), for the per-frame guards: bytes written by an in-place {@link InstancedPie}
 *  update. A frame whose columns are the arrays last written adds 0; a position frame adds the centres alone. */
export const pieColumnStats = { bytes: 0 };

/** {@link writeIfChanged} for the pie lane's columns, counting the bytes into {@link pieColumnStats}. */
function writePieColumn<T extends ArrayBufferView>(buffer: Buffer, arr: T, last: T): T {
  if (arr !== last) pieColumnStats.bytes += arr.byteLength;
  return writeIfChanged(buffer, arr, last);
}

/** Border-column uploads of the instanced circles (#513), for the per-frame guards: one per `borders` or
 *  `borderColors` array written to its buffer. A frame whose border columns are the arrays last written adds 0. */
export const borderColumnStats = { writes: 0 };

/** The value a vec2 offset attribute reads without a buffer: a WebGL constant attribute, shared and never written. */
const ZERO_OFFSET = new Float32Array(2);

/** Offset uploads (#509), for the per-frame guards: `buffers` created and `bytes` written to them. A layer without
 *  offsets adds to neither; a frame whose offset columns are the same arrays as the last adds 0 bytes. */
export const offsetColumnStats = { buffers: 0, bytes: 0 };

/** Bind each named offset attribute to the constant (0, 0) on `model`: no buffer, no upload (#509). */
export function zeroOffsets(model: Model, names: readonly string[]): void {
  const constants: Record<string, Float32Array> = {};
  for (const name of names) constants[name] = ZERO_OFFSET;
  model.setConstantAttributes(constants);
}

/** The buffer-layout entry of a per-instance vec2 offset attribute. */
export function offsetLayout(name: string): { name: string; format: "float32x2"; stepMode: "instance" } {
  return { name, format: "float32x2", stepMode: "instance" };
}

/**
 * An optional per-instance offset column (#509): a vec2 in the layer's size units that the shader adds to an
 * instance's end after projecting it (screen) or before (world).
 *
 * Without data the attribute is a WebGL **constant attribute** (0, 0): its location is disabled in the VAO and
 * reads the context's constant, so a layer without offsets allocates no buffer and uploads nothing, and a draw
 * costs one `vertexAttrib2fv` more (luma.gl re-applies constants per draw). With data it is an instance buffer
 * written only when the array is a new object, like the style columns (#179): reference-stable offsets upload
 * once, never on a zoom frame. An array rewritten in place uploads only the instance ranges the emit names as
 * changed (a state node drag: the held state nodes and their links' ends, not the whole column). The template attribute is pinned at location 0 in each shader, because luma.gl
 * disables location 0 only on Chrome, so an offset never lands there.
 */
class OffsetColumn {
  private buffer: Buffer | null = null;
  private last: Float32Array | undefined;
  /** Instances the buffer has room for. */
  private room = 0;
  constructor(readonly name: string) {}

  /** Bind `data` on `models`, or the constant zero when it is absent, uploading only a new array. A new buffer
   *  takes the layer's `capacity`, so it grows with the other columns. */
  sync(device: Device, models: readonly Model[], data: Float32Array | undefined, count: number, capacity: number, changed?: Uint32Array): void {
    if (!data) {
      if (!this.buffer) return;
      this.buffer.destroy();
      this.buffer = null;
      this.last = undefined;
      for (const m of models) zeroOffsets(m, [this.name]);
      return;
    }
    if (data === this.last && this.room >= count) {
      // Rewritten in place (#509): only the changed instance ranges, 8 B per instance.
      if (changed && this.buffer) {
        for (let k = 0; k + 1 < changed.length; k += 2) {
          const start = changed[k] ?? 0, end = Math.min(changed[k + 1] ?? 0, count);
          if (end <= start) continue;
          this.buffer.write(data.subarray(2 * start, 2 * end), 8 * start);
          offsetColumnStats.bytes += 8 * (end - start);
        }
      }
      return;
    }
    if (this.buffer && this.room >= count) this.buffer.write(data);
    else if (!this.buffer && count === 0) return; // nothing to draw yet: the constant zero until there is
    else {
      this.buffer?.destroy();
      this.room = Math.max(count, capacity);
      this.buffer = grownBuffer(device, data, count, this.room);
      offsetColumnStats.buffers++;
      for (const m of models) m.setAttributes({ [this.name]: this.buffer });
    }
    offsetColumnStats.bytes += data.byteLength;
    this.last = data;
  }

  destroy(): void {
    this.buffer?.destroy();
    this.buffer = null;
  }
}

/** The end-offset attributes of a link layer (lines, arrows, half-arrows), shared with the indexed draws. */
export const END_OFFSETS = ["a_sourceOffset", "a_targetOffset"] as const;

/** The two end-offset columns of a link layer: `sourceOffsets` / `targetOffsets`. */
class EndOffsets {
  private readonly source = new OffsetColumn(END_OFFSETS[0]);
  private readonly target = new OffsetColumn(END_OFFSETS[1]);
  readonly layout = END_OFFSETS.map(offsetLayout);

  /** Start `models` on the constant zero, then bind `data`'s columns. */
  init(device: Device, models: readonly Model[], data: EndOffsetData, capacity: number): void {
    for (const m of models) zeroOffsets(m, END_OFFSETS);
    this.sync(device, models, data, capacity);
  }
  sync(device: Device, models: readonly Model[], data: EndOffsetData, capacity: number): void {
    this.source.sync(device, models, data.sourceOffsets, data.count, capacity, data.endOffsetsChanged);
    this.target.sync(device, models, data.targetOffsets, data.count, capacity, data.endOffsetsChanged);
  }
  destroy(): void {
    this.source.destroy();
    this.target.destroy();
  }
}

interface EndOffsetData {
  sourceOffsets?: Float32Array;
  targetOffsets?: Float32Array;
  endOffsetsChanged?: Uint32Array;
  count: number;
}

export class InstancedCircles {
  count: number;
  /** Current buffer capacity (in instances). Used by update() to decide grow vs. sub-update. */
  private _capacity: number;
  /** Instances the buffers have room for (≥ `count`): kept on a shrink, at least doubled on a grow. */
  get capacity(): number {
    return this._capacity;
  }
  /** Whether the current buffers were allocated with borders (optional-field shape). */
  private _hasBorders: boolean;
  private model: Model;
  private corner: Buffer;
  private center: Buffer;
  private radius: Buffer;
  private color: Buffer;
  private border: Buffer;
  private borderColor: Buffer;
  /** Last-uploaded border columns (#513), the {@link writeIfChanged} skip: the network's no-LOD cache hands out
   *  the same flow-border / node-border arrays on every position frame, so they upload once per style version. */
  private lastBorders: Float32Array | undefined;
  private lastBorderColors: Uint8Array | undefined;
  /** Per-instance offset from the centre (#509); the constant zero without one. */
  private readonly offset = new OffsetColumn("a_offset");
  private hl: HighlightBuffers;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedCirclesData, width = 0, height = 0) {
    this.count = data.count;
    this._capacity = data.count;
    this._hasBorders = data.borders != null;
    this.corner = device.createBuffer({ data: QUAD });
    this.center = device.createBuffer({ data: data.centers });
    this.radius = device.createBuffer({ data: data.radii });
    this.color = device.createBuffer({ data: data.colors });
    // Flow-border ring (#104 N6), optional: a per-instance thickness fraction + colour. Absent ⇒
    // zero-filled, so a_border = 0 and the shader draws a plain filled disc (unchanged appearance).
    this.border = device.createBuffer({ data: data.borders ?? new Float32Array(data.count) });
    this.borderColor = device.createBuffer({ data: data.borderColors ?? new Uint8Array(data.count * 4) });
    this.lastBorders = data.borders;
    this.lastBorderColors = data.borderColors;
    borderColumnStats.writes += data.borders ? 2 : 0;
    this.hl = new HighlightBuffers(device, data); // #162 shader highlight (a_group / a_selected)
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width, height],
      u_borderPx: data.bordersPx ? 1 : 0, // #495: px rings on world discs
      ...highlightUniforms(0), // nodes are dimmed/kept but not recoloured (recolor = 0)
    };
    this.model = new Model(device, {
      vs: INSTANCED_CIRCLE_VS,
      fs: INSTANCED_CIRCLE_FS,
      bufferLayout: [
        { name: "a_corner", format: "float32x2" },
        { name: "a_center", format: "float32x2", stepMode: "instance" },
        { name: "a_radius", format: "float32", stepMode: "instance" },
        { name: "a_color", format: "unorm8x4", stepMode: "instance" },
        { name: "a_border", format: "float32", stepMode: "instance" },
        { name: "a_borderColor", format: "unorm8x4", stepMode: "instance" },
        offsetLayout("a_offset"),
        ...this.hl.layout,
      ],
      attributes: {
        a_corner: this.corner,
        a_center: this.center,
        a_radius: this.radius,
        a_color: this.color,
        a_border: this.border,
        a_borderColor: this.borderColor,
        ...this.hl.attributes(),
      },
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-strip",
      vertexCount: 4,
      instanceCount: this.count,
    });
    zeroOffsets(this.model, ["a_offset"]);
    this.offset.sync(device, [this.model], data.offsets, data.count, this._capacity, data.offsetsChanged);
  }

  /** Set shader-highlight uniforms (#162) — a hover/selection restyle with no geometry touch. */
  setHighlight(h: InstancedHighlight): void {
    applyHighlight(this.uniforms, h);
    if (h.selected) this.hl.writeSelected(h.selected, this.count);
  }

  /** Set the column-major mat3 clip transform (from {@link clipFromView}). */
  setTransform(m: Float32Array): void {
    this.uniforms["u_transform"] = m;
  }
  setViewport(width: number, height: number): void {
    this.uniforms["u_viewport"] = [width, height];
  }
  setSizeMode(mode: "world" | "screen"): void {
    this.uniforms["u_screen"] = mode === "screen" ? 1 : 0;
  }

  /**
   * Update the instance data in place (no object recreation). Uses `gl.bufferSubData` when
   * `data.count ≤ current buffer capacity`; reallocates the internal GL buffers (but keeps the
   * SAME `InstancedCircles` object) when the new count exceeds capacity. If the optional-field
   * shape changes (borders present↔absent), falls back to a full buffer reinit.
   *
   * This is the per-frame hot path for the declutter instanced lane: calling this instead of
   * destroy()+new InstancedCircles() avoids per-frame GPU buffer teardown+recreate.
   */
  update(device: Device, data: InstancedCirclesData): void {
    this.uniforms["u_borderPx"] = data.bordersPx ? 1 : 0;
    const hasBorders = data.borders != null;
    // If optional-field shape changed or count exceeds capacity, reinit buffers.
    if (data.count > this._capacity || hasBorders !== this._hasBorders) {
      // Grow: destroy old instance buffers and create new ones at the new capacity.
      this.center.destroy();
      this.radius.destroy();
      this.color.destroy();
      this.border.destroy();
      this.borderColor.destroy();
      // A grow at least doubles the room; a borders shape change within it reallocates at the count, as before.
      if (data.count > this._capacity) this._capacity = grownCapacity(data.count, this._capacity);
      else this._capacity = data.count;
      this._hasBorders = hasBorders;
      this.center = grownBuffer(device, data.centers, data.count, this._capacity);
      this.radius = grownBuffer(device, data.radii, data.count, this._capacity);
      this.color = grownBuffer(device, data.colors, data.count, this._capacity);
      this.border = grownBuffer(device, data.borders ?? new Float32Array(data.count), data.count, this._capacity);
      this.borderColor = grownBuffer(device, data.borderColors ?? new Uint8Array(data.count * 4), data.count, this._capacity);
      this.lastBorders = data.borders;
      this.lastBorderColors = data.borderColors;
      borderColumnStats.writes += data.borders ? 2 : 0;
      // Re-bind all attributes on the model (the buffer objects changed).
      this.model.setAttributes({
        a_center: this.center,
        a_radius: this.radius,
        a_color: this.color,
        a_border: this.border,
        a_borderColor: this.borderColor,
        ...this.hl.recreate(data, this._capacity), // #162 group/selected grow with the geometry
      });
    } else if (data.count > 0) {
      // Sub-update: upload only the filled portion of the scratch buffers. An empty update (a highlight lane
      // with nothing highlighted, #478) writes nothing: the layer keeps its buffers and draws nothing.
      this.center.write(data.centers);
      this.radius.write(data.radii);
      this.color.write(data.colors);
      if (data.borders && data.borderColors) {
        // Skipped while the arrays are the ones last uploaded (#513): a position frame's cached border columns.
        if (data.borders !== this.lastBorders) borderColumnStats.writes++;
        if (data.borderColors !== this.lastBorderColors) borderColumnStats.writes++;
        this.lastBorders = writeIfChanged(this.border, data.borders, this.lastBorders);
        this.lastBorderColors = writeIfChanged(this.borderColor, data.borderColors, this.lastBorderColors);
      }
      this.hl.write(data); // #162 refresh group/selected for the new frame's instances
    }
    this.offset.sync(device, [this.model], data.offsets, data.count, this._capacity, data.offsetsChanged);
    this.count = data.count;
    this.model.setInstanceCount(data.count);
  }

  render(pass: RenderPass): void {
    if (this.count > 0) this.model.draw(pass);
  }
  destroy(): void {
    this.model.destroy();
    this.corner.destroy();
    this.center.destroy();
    this.radius.destroy();
    this.color.destroy();
    this.border.destroy();
    this.borderColor.destroy();
    this.offset.destroy();
    this.hl.destroy();
  }
}

/**
 * GPU-instanced **pie wedges** (#171) — one instance per wedge, reusing the circle's quad positioning
 * (per-instance centre/radius + world/screen sizeMode). The fragment discards outside the disc and
 * outside the wedge's `[startFrac, endFrac]` angular slice, so a full pie is one instanced draw and
 * updates in place like {@link InstancedCircles}. Group id = the physical node id, so a hover/select
 * lights the whole pie (#162).
 */
export class InstancedPie {
  count: number;
  private _capacity: number;
  /** Instances the buffers have room for (≥ `count`): kept on a shrink, at least doubled on a grow. */
  get capacity(): number {
    return this._capacity;
  }
  private model: Model;
  private corner: Buffer;
  private center: Buffer;
  private radius: Buffer;
  private angles: Buffer;
  private color: Buffer;
  /** The per-wedge outer band column (#507); a layer without one reads {@link InstancedPie.noBorders}. */
  private border: Buffer;
  /** The columns last uploaded (#494): an update re-uploads only a column that is a new array, so a restyle
   *  that keeps the geometry (a palette change) uploads the colours alone. */
  private last: { centers: Float32Array; radii: Float32Array; angles: Float32Array; colors: Uint8Array; borders: Float32Array };
  /** The zero band column of a layer without `borders`, kept across updates, so it is the same array each
   *  update and uploads only when the wedge count changes. */
  private zeros = new Float32Array(0);
  private hl: HighlightBuffers;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedPieData, width = 0, height = 0) {
    this.count = data.count;
    this._capacity = data.count;
    this.corner = device.createBuffer({ data: QUAD });
    this.center = device.createBuffer({ data: data.centers });
    this.radius = device.createBuffer({ data: data.radii });
    this.angles = device.createBuffer({ data: data.angles });
    this.color = device.createBuffer({ data: data.colors });
    const borders = this.bordersOf(data);
    this.border = device.createBuffer({ data: borders });
    this.last = { centers: data.centers, radii: data.radii, angles: data.angles, colors: data.colors, borders };
    this.hl = new HighlightBuffers(device, data); // #162 shader highlight (a_group / a_selected)
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width, height],
      u_borderDarken: data.borderDarken ?? 1,
      ...highlightUniforms(0), // pie is a node glyph — dimmed/kept, not recoloured (recolor = 0)
    };
    this.model = new Model(device, {
      vs: INSTANCED_PIE_VS,
      fs: INSTANCED_PIE_FS,
      bufferLayout: [
        { name: "a_corner", format: "float32x2" },
        { name: "a_center", format: "float32x2", stepMode: "instance" },
        { name: "a_radius", format: "float32", stepMode: "instance" },
        { name: "a_angles", format: "float32x2", stepMode: "instance" },
        { name: "a_color", format: "unorm8x4", stepMode: "instance" },
        { name: "a_border", format: "float32", stepMode: "instance" },
        ...this.hl.layout,
      ],
      attributes: {
        a_corner: this.corner,
        a_center: this.center,
        a_radius: this.radius,
        a_angles: this.angles,
        a_color: this.color,
        a_border: this.border,
        ...this.hl.attributes(),
      },
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-strip",
      vertexCount: 4,
      instanceCount: this.count,
    });
  }

  setHighlight(h: InstancedHighlight): void {
    applyHighlight(this.uniforms, h);
    if (h.selected) this.hl.writeSelected(h.selected, this.count);
  }
  setTransform(m: Float32Array): void {
    this.uniforms["u_transform"] = m;
  }
  setViewport(width: number, height: number): void {
    this.uniforms["u_viewport"] = [width, height];
  }
  setSizeMode(mode: "world" | "screen"): void {
    this.uniforms["u_screen"] = mode === "screen" ? 1 : 0;
  }

  /** In-place instance update (mirrors {@link InstancedCircles.update}): sub-upload while the wedge
   *  count fits capacity, else reallocate the instance buffers (keeping the same object). */
  update(device: Device, data: InstancedPieData): void {
    const borders = this.bordersOf(data);
    this.uniforms["u_borderDarken"] = data.borderDarken ?? 1;
    if (data.count > this._capacity) {
      this.center.destroy();
      this.radius.destroy();
      this.angles.destroy();
      this.color.destroy();
      this.border.destroy();
      this._capacity = grownCapacity(data.count, this._capacity);
      this.center = grownBuffer(device, data.centers, data.count, this._capacity);
      this.radius = grownBuffer(device, data.radii, data.count, this._capacity);
      this.angles = grownBuffer(device, data.angles, data.count, this._capacity);
      this.color = grownBuffer(device, data.colors, data.count, this._capacity);
      this.border = grownBuffer(device, borders, data.count, this._capacity);
      this.model.setAttributes({
        a_center: this.center,
        a_radius: this.radius,
        a_angles: this.angles,
        a_color: this.color,
        a_border: this.border,
        ...this.hl.recreate(data, this._capacity),
      });
      this.last = { centers: data.centers, radii: data.radii, angles: data.angles, colors: data.colors, borders };
    } else {
      const last = this.last;
      this.last = {
        centers: writePieColumn(this.center, data.centers, last.centers),
        radii: writePieColumn(this.radius, data.radii, last.radii),
        angles: writePieColumn(this.angles, data.angles, last.angles),
        colors: writePieColumn(this.color, data.colors, last.colors),
        borders: writePieColumn(this.border, borders, last.borders),
      };
      this.hl.write(data);
    }
    this.count = data.count;
    this.model.setInstanceCount(data.count);
  }

  render(pass: RenderPass): void {
    if (this.count > 0) this.model.draw(pass);
  }
  destroy(): void {
    this.model.destroy();
    this.corner.destroy();
    this.center.destroy();
    this.radius.destroy();
    this.angles.destroy();
    this.color.destroy();
    this.border.destroy();
    this.hl.destroy();
  }

  /** The layer's band column, else the kept zero column, rebuilt only when the wedge count changes. */
  private bordersOf(data: InstancedPieData): Float32Array {
    if (data.borders) return data.borders;
    if (this.zeros.length !== data.count) this.zeros = new Float32Array(data.count);
    return this.zeros;
  }
}

/**
 * Path-strip template: M samples × 2 sides as a triangle-strip, `(t, side)` per vertex with
 * `t = i/(M-1)` walking the path and `side ∈ {-1,1}` picking the edge. M=2 is the straight case
 * (= the original 4-vertex strip); higher M traces a smooth bezier (#104 N6c).
 */
export function lineTemplate(samples: number): Float32Array {
  const M = Math.max(2, samples | 0);
  const t = new Float32Array(M * 4);
  for (let i = 0; i < M; i++) {
    const tt = i / (M - 1);
    t[i * 4] = tt;
    t[i * 4 + 1] = -1;
    t[i * 4 + 2] = tt;
    t[i * 4 + 3] = 1;
  }
  return t;
}

/**
 * {@link lineTemplate} with the arrowhead appended (#542): (2, 1) left barb, (2, -1) right barb, (3, 0) tip.
 * The strip's two triangles from the shaft's last pair to the barbs lie on the head's base (zero area), so
 * `2·M + 3` vertices draw shaft + head as one strip with no overlap (`INSTANCED_HEAD_LINE_VS`).
 */
export function headLineTemplate(samples: number): Float32Array {
  const shaft = lineTemplate(samples);
  const t = new Float32Array(shaft.length + 6);
  t.set(shaft);
  t.set([2, 1, 2, -1, 3, 0], shaft.length);
  return t;
}

/** The value the radius attribute reads without a buffer: a WebGL constant attribute, shared and never written. */
const ZERO_RADIUS = new Float32Array(1);

/** Radius-column uploads of headed lines (#542), for the per-frame guards: `buffers` created and `bytes` written.
 *  An unheaded layer adds to neither; a frame whose radii are the array last written adds 0 bytes. */
export const radiusColumnStats = { buffers: 0, bytes: 0 };

/**
 * A headed line layer's per-instance target radius `a_radius` (#542), 4 B per instance: an instance buffer
 * written only when the array is a new object (like the style columns, #179), or without data the WebGL
 * constant 0 (no buffer, no upload; the tip then sits on the target point).
 */
class RadiusColumn {
  static readonly layout = [{ name: "a_radius", format: "float32" as const, stepMode: "instance" as const }];
  private buffer: Buffer | null = null;
  private last: Float32Array | undefined;
  private room = 0;

  sync(device: Device, models: readonly Model[], data: Float32Array | undefined, count: number, capacity: number, init = false): void {
    if (!data) {
      if (!this.buffer && !init) return;
      this.buffer?.destroy();
      this.buffer = null;
      this.last = undefined;
      this.room = 0;
      for (const m of models) m.setConstantAttributes({ a_radius: ZERO_RADIUS });
      return;
    }
    if (data === this.last && this.room >= count) return;
    radiusColumnStats.bytes += data.byteLength;
    this.last = data;
    if (this.buffer && this.room >= count) {
      this.buffer.write(data);
      return;
    }
    this.buffer?.destroy();
    this.room = Math.max(count, capacity);
    this.buffer = grownBuffer(device, data, count, this.room);
    radiusColumnStats.buffers++;
    for (const m of models) m.setAttributes({ a_radius: this.buffer });
  }

  destroy(): void {
    this.buffer?.destroy();
    this.buffer = null;
  }
}

export class InstancedLines {
  count: number;
  /** Current buffer capacity (in instances). Used by update() to decide grow vs. sub-update. */
  private _capacity: number;
  /** Instances the buffers have room for (≥ `count`): kept on a shrink, at least doubled on a grow. */
  get capacity(): number {
    return this._capacity;
  }
  /** Vertex samples (M) baked into the corner template buffer — if data.samples changes, caller must recreate. */
  private _samples: number;
  /** Last-uploaded style-derived array refs (#179) — a sub-update skips a buffer whose ref is unchanged. */
  private _lastWidths?: Float32Array;
  private _lastColors?: Uint8Array;
  private _lastBends?: Float32Array;
  private model: Model;
  /** Pick-pass twin (#141): same VS/geometry, PICK_FS, no blend. Built only when `pick` is set. */
  private pickModel?: Model;
  private corner: Buffer;
  private source: Buffer;
  private target: Buffer;
  private widthBuf: Buffer;
  private color: Buffer;
  private bend: Buffer;
  /** The ends' offsets (#509); the constant zero without them. */
  private readonly ends = new EndOffsets();
  /** Drawn with its arrowhead (#542, `arrowSize` set): fixed per layer, a change recreates (like `samples`). */
  private readonly headed: boolean;
  /** The target radii of a headed layer (#542); null on an unheaded one (no attribute, today's program). */
  private readonly radius: RadiusColumn | null;
  private hl: HighlightBuffers;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedLinesData, width = 0, height = 0, pick = false) {
    this.count = data.count;
    this._capacity = data.count;
    const samples = Math.max(2, (data.samples ?? 2) | 0);
    this._samples = samples;
    this.headed = data.arrowSize !== undefined;
    this.radius = this.headed ? new RadiusColumn() : null;
    const vs = this.headed ? INSTANCED_HEAD_LINE_VS : INSTANCED_LINE_VS;
    const vertexCount = this.headed ? samples * 2 + 3 : samples * 2;
    this.corner = device.createBuffer({ data: this.headed ? headLineTemplate(samples) : lineTemplate(samples) });
    this.source = device.createBuffer({ data: data.sources });
    this.target = device.createBuffer({ data: data.targets });
    this.widthBuf = device.createBuffer({ data: data.widths });
    this.color = device.createBuffer({ data: data.colors });
    // Per-instance bend (#104 N6c), optional: absent ⇒ zero ⇒ straight (control on the chord).
    this.bend = device.createBuffer({ data: data.bends ?? new Float32Array(data.count) });
    this._lastWidths = data.widths;
    this._lastColors = data.colors;
    this._lastBends = data.bends;
    this.hl = new HighlightBuffers(device, data); // #162 shader highlight (a_group / a_selected)
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width, height],
      u_pickBase: 0,
      ...highlightUniforms(1), // links recolour toward the highlight hue (recolor = 1)
      ...(this.headed ? { u_arrowSize: data.arrowSize ?? 0 } : {}),
    };
    const bufferLayout = [
      { name: "a_corner", format: "float32x2" as const },
      { name: "a_source", format: "float32x2" as const, stepMode: "instance" as const },
      { name: "a_target", format: "float32x2" as const, stepMode: "instance" as const },
      { name: "a_width", format: "float32" as const, stepMode: "instance" as const },
      { name: "a_color", format: "unorm8x4" as const, stepMode: "instance" as const },
      { name: "a_bend", format: "float32" as const, stepMode: "instance" as const },
      ...this.ends.layout,
      ...(this.headed ? RadiusColumn.layout : []),
      ...this.hl.layout,
    ];
    const attributes = {
      a_corner: this.corner,
      a_source: this.source,
      a_target: this.target,
      a_width: this.widthBuf,
      a_color: this.color,
      a_bend: this.bend,
      ...this.hl.attributes(),
    };
    this.model = new Model(device, {
      vs,
      fs: FILL_FS,
      bufferLayout,
      attributes,
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-strip",
      vertexCount,
      instanceCount: this.count,
    });
    // Pick twin: identical geometry + shared instance buffers/uniforms, PICK_FS writes gl_InstanceID.
    if (pick) {
      this.pickModel = new Model(device, {
        vs,
        fs: PICK_FS,
        bufferLayout,
        attributes,
        uniforms: this.uniforms,
        parameters: NO_BLEND,
        topology: "triangle-strip",
        vertexCount,
        instanceCount: this.count,
      });
    }
    this.ends.init(device, this.models(), data, this._capacity);
    this.radius?.sync(device, this.models(), data.radii, data.count, this._capacity, true);
  }

  /** The fill model and its pick twin, which share the instance attributes. */
  private models(): Model[] {
    return this.pickModel ? [this.model, this.pickModel] : [this.model];
  }

  setTransform(m: Float32Array): void {
    this.uniforms["u_transform"] = m;
  }
  setViewport(width: number, height: number): void {
    this.uniforms["u_viewport"] = [width, height];
  }
  setSizeMode(mode: "world" | "screen"): void {
    this.uniforms["u_screen"] = mode === "screen" ? 1 : 0;
  }
  /** Offset added to the pick pass's instance id (#447), so two pickable link layers decode to disjoint ids. */
  setPickBase(base: number): void {
    this.uniforms["u_pickBase"] = base;
  }
  /** Set shader-highlight uniforms (#162) — recolour/dim with no geometry touch (shared with the pick twin). */
  setHighlight(h: InstancedHighlight): void {
    applyHighlight(this.uniforms, h);
    if (h.selected) this.hl.writeSelected(h.selected, this.count);
  }

  /**
   * Update the instance data in place (no object recreation). Uses `gl.bufferSubData` when
   * `data.count ≤ current buffer capacity`; reallocates the per-instance buffers (but keeps the
   * SAME `InstancedLines` object) when the new count exceeds capacity. If `data.samples` changed
   * (the vertex template must be rebuilt), the caller must destroy+recreate instead — this method
   * returns `false` in that case so `updateInstancedLayer` falls back to `setInstancedLayer`.
   *
   * The pick model tracks the same instance buffers (shared references), so endpoint moves are
   * automatically reflected in the pick pass — ids/count are unchanged, only positions moved.
   */
  update(device: Device, data: InstancedLinesData): boolean {
    if (data.index) return false; // indexed draw (#447) is a different renderer — caller must recreate
    const newSamples = Math.max(2, (data.samples ?? 2) | 0);
    if (newSamples !== this._samples) return false; // vertex template changed — caller must recreate
    if ((data.arrowSize !== undefined) !== this.headed) return false; // head on/off changes the program (#542)
    if (this.headed) this.uniforms["u_arrowSize"] = data.arrowSize ?? 0;
    if (data.count > this._capacity) {
      // Grow: destroy old per-instance buffers and allocate at the new capacity.
      this.source.destroy();
      this.target.destroy();
      this.widthBuf.destroy();
      this.color.destroy();
      this.bend.destroy();
      this._capacity = grownCapacity(data.count, this._capacity);
      this.source = grownBuffer(device, data.sources, data.count, this._capacity);
      this.target = grownBuffer(device, data.targets, data.count, this._capacity);
      this.widthBuf = grownBuffer(device, data.widths, data.count, this._capacity);
      this.color = grownBuffer(device, data.colors, data.count, this._capacity);
      this.bend = grownBuffer(device, data.bends ?? new Float32Array(data.count), data.count, this._capacity);
      // Fresh buffers were created from these arrays — record the refs so a later sub-update skips them.
      this._lastWidths = data.widths;
      this._lastColors = data.colors;
      this._lastBends = data.bends;
      this.model.setAttributes({
        a_source: this.source,
        a_target: this.target,
        a_width: this.widthBuf,
        a_color: this.color,
        a_bend: this.bend,
        ...this.hl.recreate(data, this._capacity),
      });
      if (this.pickModel) {
        this.pickModel.setAttributes({
          a_source: this.source,
          a_target: this.target,
          a_width: this.widthBuf,
          a_color: this.color,
          a_bend: this.bend,
          ...this.hl.attributes(),
        });
      }
    } else {
      // Sub-update: endpoints are freshly allocated each frame ⇒ always upload; style-derived buffers
      // (widths/colours/bends) skip when their array reference is unchanged (the position-only fast path, #179).
      this.source.write(data.sources);
      this.target.write(data.targets);
      this._lastWidths = writeIfChanged(this.widthBuf, data.widths, this._lastWidths);
      this._lastColors = writeIfChanged(this.color, data.colors, this._lastColors);
      if (data.bends) this._lastBends = writeIfChanged(this.bend, data.bends, this._lastBends);
      this.hl.write(data);
    }
    this.ends.sync(device, this.models(), data, this._capacity);
    this.radius?.sync(device, this.models(), data.radii, data.count, this._capacity);
    this.count = data.count;
    this.model.setInstanceCount(data.count);
    this.pickModel?.setInstanceCount(data.count);
    return true;
  }

  render(pass: RenderPass): void {
    if (this.count > 0) this.model.draw(pass);
  }
  /** Draw the id-encoded pick pass (#141). No-op unless built with `pick`. */
  renderPick(pass: RenderPass): void {
    if (this.pickModel && this.count > 0) this.pickModel.draw(pass);
  }
  destroy(): void {
    this.model.destroy();
    this.pickModel?.destroy();
    this.corner.destroy();
    this.source.destroy();
    this.target.destroy();
    this.widthBuf.destroy();
    this.color.destroy();
    this.bend.destroy();
    this.ends.destroy();
    this.radius?.destroy();
    this.hl.destroy();
  }
}

/** Triangle template for an arrowhead: tip (0,0), base (2,-1)/(2,1), triangle-list. */
export const ARROW_TEMPLATE = new Float32Array([0, 0, 2, -1, 2, 1]);
/** One-sided "half" arrowhead (#104 N6c): tip (0,0), base on one side only (2,0)/(2,1). */
export const HALF_ARROW_TEMPLATE = new Float32Array([0, 0, 2, 0, 2, 1]);

export class InstancedArrows {
  count: number;
  /** Current buffer capacity (in instances). Used by update() to decide grow vs. sub-update. */
  private _capacity: number;
  /** Instances the buffers have room for (≥ `count`): kept on a shrink, at least doubled on a grow. */
  get capacity(): number {
    return this._capacity;
  }
  /** Whether the vertex template was built for the "half" arrowhead shape. If this changes, caller must recreate. */
  private _half: boolean;
  /** Last-uploaded style-derived array refs (#179) — a sub-update skips a buffer whose ref is unchanged. */
  private _lastSizes?: Float32Array;
  private _lastRadii?: Float32Array;
  private _lastColors?: Uint8Array;
  private _lastBends?: Float32Array;
  private model: Model;
  /** Pick-pass twin (#141): same VS/geometry, PICK_FS, no blend. Built only when `pick` is set. */
  private pickModel?: Model;
  private tri: Buffer;
  private source: Buffer;
  private target: Buffer;
  private size: Buffer;
  private radius: Buffer;
  private color: Buffer;
  private bend: Buffer;
  /** The ends' offsets (#509); the constant zero without them. */
  private readonly ends = new EndOffsets();
  private hl: HighlightBuffers;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedArrowsData, width = 0, height = 0, pick = false) {
    this.count = data.count;
    this._capacity = data.count;
    this._half = !!data.half;
    this.tri = device.createBuffer({ data: data.half ? HALF_ARROW_TEMPLATE : ARROW_TEMPLATE });
    this.source = device.createBuffer({ data: data.sources });
    this.target = device.createBuffer({ data: data.targets });
    this.size = device.createBuffer({ data: data.sizes });
    this.radius = device.createBuffer({ data: data.radii });
    this.color = device.createBuffer({ data: data.colors });
    // Per-instance bend (#104 N6c), optional: absent ⇒ zero ⇒ oriented along the chord, as before.
    this.bend = device.createBuffer({ data: data.bends ?? new Float32Array(data.count) });
    this._lastSizes = data.sizes;
    this._lastRadii = data.radii;
    this._lastColors = data.colors;
    this._lastBends = data.bends;
    this.hl = new HighlightBuffers(device, data); // #162 shader highlight (a_group / a_selected)
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width || 1, height || 1],
      u_pickBase: 0,
      ...highlightUniforms(1), // arrows recolour with their link
    };
    const bufferLayout = [
      { name: "a_tri", format: "float32x2" as const },
      { name: "a_source", format: "float32x2" as const, stepMode: "instance" as const },
      { name: "a_target", format: "float32x2" as const, stepMode: "instance" as const },
      { name: "a_size", format: "float32" as const, stepMode: "instance" as const },
      { name: "a_radius", format: "float32" as const, stepMode: "instance" as const },
      { name: "a_bend", format: "float32" as const, stepMode: "instance" as const },
      { name: "a_color", format: "unorm8x4" as const, stepMode: "instance" as const },
      ...this.ends.layout,
      ...this.hl.layout,
    ];
    const attributes = {
      a_tri: this.tri,
      a_source: this.source,
      a_target: this.target,
      a_size: this.size,
      a_radius: this.radius,
      a_bend: this.bend,
      a_color: this.color,
      ...this.hl.attributes(),
    };
    this.model = new Model(device, {
      vs: INSTANCED_ARROW_VS,
      fs: FILL_FS,
      bufferLayout,
      attributes,
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-list",
      vertexCount: 3,
      instanceCount: this.count,
    });
    if (pick) {
      this.pickModel = new Model(device, {
        vs: INSTANCED_ARROW_VS,
        fs: PICK_FS,
        bufferLayout,
        attributes,
        uniforms: this.uniforms,
        parameters: NO_BLEND,
        topology: "triangle-list",
        vertexCount: 3,
        instanceCount: this.count,
      });
    }
    this.ends.init(device, this.models(), data, this._capacity);
  }

  /** The fill model and its pick twin, which share the instance attributes. */
  private models(): Model[] {
    return this.pickModel ? [this.model, this.pickModel] : [this.model];
  }

  setTransform(m: Float32Array): void {
    this.uniforms["u_transform"] = m;
  }
  setViewport(width: number, height: number): void {
    this.uniforms["u_viewport"] = [width, height];
  }
  setSizeMode(mode: "world" | "screen"): void {
    this.uniforms["u_screen"] = mode === "screen" ? 1 : 0;
  }
  /** Offset added to the pick pass's instance id (#447), so two pickable link layers decode to disjoint ids. */
  setPickBase(base: number): void {
    this.uniforms["u_pickBase"] = base;
  }
  /** Set shader-highlight uniforms (#162) — recolour/dim with no geometry touch (shared with the pick twin). */
  setHighlight(h: InstancedHighlight): void {
    applyHighlight(this.uniforms, h);
    if (h.selected) this.hl.writeSelected(h.selected, this.count);
  }

  /**
   * Update the instance data in place (no object recreation). Mirrors {@link InstancedLines.update}.
   * Returns `false` when the `half` flag changed (vertex template must be rebuilt — caller recreates).
   * The pick model shares the same instance buffers, so pick geometry tracks the new endpoints automatically.
   */
  update(device: Device, data: InstancedArrowsData): boolean {
    if (data.index) return false; // indexed draw (#447) is a different renderer — caller must recreate
    if (!!data.half !== this._half) return false; // vertex template changed — caller must recreate
    if (data.count > this._capacity) {
      // Grow: destroy old per-instance buffers and allocate at the new capacity.
      this.source.destroy();
      this.target.destroy();
      this.size.destroy();
      this.radius.destroy();
      this.color.destroy();
      this.bend.destroy();
      this._capacity = grownCapacity(data.count, this._capacity);
      this.source = grownBuffer(device, data.sources, data.count, this._capacity);
      this.target = grownBuffer(device, data.targets, data.count, this._capacity);
      this.size = grownBuffer(device, data.sizes, data.count, this._capacity);
      this.radius = grownBuffer(device, data.radii, data.count, this._capacity);
      this.color = grownBuffer(device, data.colors, data.count, this._capacity);
      this.bend = grownBuffer(device, data.bends ?? new Float32Array(data.count), data.count, this._capacity);
      // Fresh buffers were created from these arrays — record the refs so a later sub-update skips them.
      this._lastSizes = data.sizes;
      this._lastRadii = data.radii;
      this._lastColors = data.colors;
      this._lastBends = data.bends;
      this.model.setAttributes({
        a_source: this.source,
        a_target: this.target,
        a_size: this.size,
        a_radius: this.radius,
        a_color: this.color,
        a_bend: this.bend,
        ...this.hl.recreate(data, this._capacity),
      });
      if (this.pickModel) {
        this.pickModel.setAttributes({
          a_source: this.source,
          a_target: this.target,
          a_size: this.size,
          a_radius: this.radius,
          a_color: this.color,
          a_bend: this.bend,
          ...this.hl.attributes(),
        });
      }
    } else {
      // Sub-update: endpoints upload every frame (freshly allocated); style-derived buffers (sizes/radii/
      // colours/bends) skip when their array reference is unchanged (the position-only fast path, #179).
      this.source.write(data.sources);
      this.target.write(data.targets);
      this._lastSizes = writeIfChanged(this.size, data.sizes, this._lastSizes);
      this._lastRadii = writeIfChanged(this.radius, data.radii, this._lastRadii);
      this._lastColors = writeIfChanged(this.color, data.colors, this._lastColors);
      if (data.bends) this._lastBends = writeIfChanged(this.bend, data.bends, this._lastBends);
      this.hl.write(data);
    }
    this.ends.sync(device, this.models(), data, this._capacity);
    this.count = data.count;
    this.model.setInstanceCount(data.count);
    this.pickModel?.setInstanceCount(data.count);
    return true;
  }

  render(pass: RenderPass): void {
    if (this.count > 0) this.model.draw(pass);
  }
  /** Draw the id-encoded pick pass (#141). No-op unless built with `pick`. */
  renderPick(pass: RenderPass): void {
    if (this.pickModel && this.count > 0) this.pickModel.draw(pass);
  }
  destroy(): void {
    this.model.destroy();
    this.pickModel?.destroy();
    this.tri.destroy();
    this.source.destroy();
    this.target.destroy();
    this.size.destroy();
    this.radius.destroy();
    this.color.destroy();
    this.bend.destroy();
    this.ends.destroy();
    this.hl.destroy();
  }
}

/**
 * Triangle-list template for one half-arrow link (#104 N6): the source foot (2 triangles), a body
 * strip of `M` samples per bezier edge (`2·(M−1)` triangles between the inner and outer curves), and
 * the barbed head (2 triangles). Each vertex is `(code, t)`: `code` selects a named anchor or the
 * inner(8)/outer(9) edge bezier evaluated at `t` (see INSTANCED_HALF_ARROW_VS).
 */
export function halfArrowTemplate(samples: number): Float32Array {
  const M = Math.max(2, samples | 0);
  const v: number[] = [];
  // Source foot: x02(1) x0(0) x04(3), then x02(1) x04(3) x03(2).
  v.push(1, 0, 0, 0, 3, 0, 1, 0, 3, 0, 2, 0);
  // Body strip between inner (code 8) and outer (code 9) edges.
  for (let i = 0; i < M - 1; i++) {
    const ti = i / (M - 1);
    const tj = (i + 1) / (M - 1);
    v.push(8, ti, 9, ti, 8, tj); // inner_i, outer_i, inner_{i+1}
    v.push(9, ti, 8, tj, 9, tj); // outer_i, inner_{i+1}, outer_{i+1}
  }
  // Head: x13(6) x14(7) x11(4), then x13(6) x11(4) x12(5).
  v.push(6, 0, 7, 0, 4, 0, 6, 0, 4, 0, 5, 0);
  return new Float32Array(v);
}

/** Path samples per bezier edge for the half-arrow strip. */
export const HALF_ARROW_SAMPLES = 24;

export class InstancedHalfArrows {
  count: number;
  /** Current buffer capacity (in instances). Used by update() to decide grow vs. sub-update. */
  private _capacity: number;
  /** Instances the buffers have room for (≥ `count`): kept on a shrink, at least doubled on a grow. */
  get capacity(): number {
    return this._capacity;
  }
  /** Vertex samples (M) baked into the kind template buffer — if data.samples changes, caller must recreate. */
  private _samples: number;
  /** Last-uploaded style-derived array refs (#179) — a sub-update skips a buffer whose ref is unchanged. */
  private _lastRadii?: Float32Array;
  private _lastWidths?: Float32Array;
  private _lastBends?: Float32Array;
  private _lastColors?: Uint8Array;
  private vertexCount: number;
  private model: Model;
  /** Pick-pass twin (#141): same VS/geometry, PICK_FS, no blend. Built only when `pick` is set. */
  private pickModel?: Model;
  private kind: Buffer;
  private source: Buffer;
  private target: Buffer;
  private radii: Buffer;
  private widths: Buffer;
  private bend: Buffer;
  private color: Buffer;
  /** The ends' offsets (#509); the constant zero without them. */
  private readonly ends = new EndOffsets();
  private hl: HighlightBuffers;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedHalfArrowsData, width = 0, height = 0, pick = false) {
    this.count = data.count;
    this._capacity = data.count;
    const samples = Math.max(2, (data.samples ?? HALF_ARROW_SAMPLES) | 0);
    this._samples = samples;
    const template = halfArrowTemplate(samples);
    this.vertexCount = template.length / 2;
    this.kind = device.createBuffer({ data: template });
    this.source = device.createBuffer({ data: data.sources });
    this.target = device.createBuffer({ data: data.targets });
    this.radii = device.createBuffer({ data: data.radii });
    this.widths = device.createBuffer({ data: data.widths });
    this.bend = device.createBuffer({ data: data.bends });
    this.color = device.createBuffer({ data: data.colors });
    this._lastRadii = data.radii;
    this._lastWidths = data.widths;
    this._lastBends = data.bends;
    this._lastColors = data.colors;
    this.hl = new HighlightBuffers(device, data); // #162 shader highlight (a_group / a_selected)
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width, height],
      u_pickBase: 0,
      ...highlightUniforms(1), // half-arrows recolour toward the highlight hue
    };
    const bufferLayout = [
      { name: "a_kind", format: "float32x2" as const },
      { name: "a_p0", format: "float32x2" as const, stepMode: "instance" as const },
      { name: "a_p1", format: "float32x2" as const, stepMode: "instance" as const },
      { name: "a_radii", format: "float32x2" as const, stepMode: "instance" as const },
      { name: "a_widths", format: "float32x2" as const, stepMode: "instance" as const },
      { name: "a_bend", format: "float32" as const, stepMode: "instance" as const },
      { name: "a_color", format: "unorm8x4" as const, stepMode: "instance" as const },
      ...this.ends.layout,
      ...this.hl.layout,
    ];
    const attributes = {
      a_kind: this.kind,
      a_p0: this.source,
      a_p1: this.target,
      a_radii: this.radii,
      a_widths: this.widths,
      a_bend: this.bend,
      a_color: this.color,
      ...this.hl.attributes(),
    };
    this.model = new Model(device, {
      vs: INSTANCED_HALF_ARROW_VS,
      fs: FILL_FS,
      bufferLayout,
      attributes,
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-list",
      vertexCount: this.vertexCount,
      instanceCount: this.count,
    });
    if (pick) {
      this.pickModel = new Model(device, {
        vs: INSTANCED_HALF_ARROW_VS,
        fs: PICK_FS,
        bufferLayout,
        attributes,
        uniforms: this.uniforms,
        parameters: NO_BLEND,
        topology: "triangle-list",
        vertexCount: this.vertexCount,
        instanceCount: this.count,
      });
    }
    this.ends.init(device, this.models(), data, this._capacity);
  }

  /** The fill model and its pick twin, which share the instance attributes. */
  private models(): Model[] {
    return this.pickModel ? [this.model, this.pickModel] : [this.model];
  }

  setTransform(m: Float32Array): void {
    this.uniforms["u_transform"] = m;
  }
  setViewport(width: number, height: number): void {
    this.uniforms["u_viewport"] = [width, height];
  }
  setSizeMode(mode: "world" | "screen"): void {
    this.uniforms["u_screen"] = mode === "screen" ? 1 : 0;
  }
  /** Offset added to the pick pass's instance id (#447), so two pickable link layers decode to disjoint ids. */
  setPickBase(base: number): void {
    this.uniforms["u_pickBase"] = base;
  }
  /** Set shader-highlight uniforms (#162) — recolour/dim with no geometry touch (shared with the pick twin). */
  setHighlight(h: InstancedHighlight): void {
    applyHighlight(this.uniforms, h);
    if (h.selected) this.hl.writeSelected(h.selected, this.count);
  }

  /**
   * Update the instance data in place (no object recreation). Mirrors {@link InstancedLines.update}.
   * Returns `false` when `data.samples` changed (vertex template must be rebuilt — caller recreates).
   * The pick model shares the same instance buffers, so pick geometry tracks the new endpoints automatically.
   */
  update(device: Device, data: InstancedHalfArrowsData): boolean {
    if (data.index) return false; // indexed draw (#447) is a different renderer — caller must recreate
    const newSamples = Math.max(2, (data.samples ?? HALF_ARROW_SAMPLES) | 0);
    if (newSamples !== this._samples) return false; // vertex template changed — caller must recreate
    if (data.count > this._capacity) {
      // Grow: destroy old per-instance buffers and allocate at the new capacity.
      this.source.destroy();
      this.target.destroy();
      this.radii.destroy();
      this.widths.destroy();
      this.bend.destroy();
      this.color.destroy();
      this._capacity = grownCapacity(data.count, this._capacity);
      this.source = grownBuffer(device, data.sources, data.count, this._capacity);
      this.target = grownBuffer(device, data.targets, data.count, this._capacity);
      this.radii = grownBuffer(device, data.radii, data.count, this._capacity);
      this.widths = grownBuffer(device, data.widths, data.count, this._capacity);
      this.bend = grownBuffer(device, data.bends, data.count, this._capacity);
      this.color = grownBuffer(device, data.colors, data.count, this._capacity);
      // Fresh buffers were created from these arrays — record the refs so a later sub-update skips them.
      this._lastRadii = data.radii;
      this._lastWidths = data.widths;
      this._lastBends = data.bends;
      this._lastColors = data.colors;
      this.model.setAttributes({
        a_p0: this.source,
        a_p1: this.target,
        a_radii: this.radii,
        a_widths: this.widths,
        a_bend: this.bend,
        a_color: this.color,
        ...this.hl.recreate(data, this._capacity),
      });
      if (this.pickModel) {
        this.pickModel.setAttributes({
          a_p0: this.source,
          a_p1: this.target,
          a_radii: this.radii,
          a_widths: this.widths,
          a_bend: this.bend,
          a_color: this.color,
          ...this.hl.attributes(),
        });
      }
    } else {
      // Sub-update: endpoints upload every frame (freshly allocated); style-derived buffers (radii/widths/
      // bends/colours) skip when their array reference is unchanged (the position-only fast path, #179).
      this.source.write(data.sources);
      this.target.write(data.targets);
      this._lastRadii = writeIfChanged(this.radii, data.radii, this._lastRadii);
      this._lastWidths = writeIfChanged(this.widths, data.widths, this._lastWidths);
      this._lastBends = writeIfChanged(this.bend, data.bends, this._lastBends);
      this._lastColors = writeIfChanged(this.color, data.colors, this._lastColors);
      this.hl.write(data);
    }
    this.ends.sync(device, this.models(), data, this._capacity);
    this.count = data.count;
    this.model.setInstanceCount(data.count);
    this.pickModel?.setInstanceCount(data.count);
    return true;
  }

  render(pass: RenderPass): void {
    if (this.count > 0) this.model.draw(pass);
  }
  /** Draw the id-encoded pick pass (#141). No-op unless built with `pick`. */
  renderPick(pass: RenderPass): void {
    if (this.pickModel && this.count > 0) this.pickModel.draw(pass);
  }
  destroy(): void {
    this.model.destroy();
    this.pickModel?.destroy();
    this.kind.destroy();
    this.source.destroy();
    this.target.destroy();
    this.radii.destroy();
    this.widths.destroy();
    this.bend.destroy();
    this.color.destroy();
    this.ends.destroy();
    this.hl.destroy();
  }
}
