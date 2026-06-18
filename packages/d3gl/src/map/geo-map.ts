import { type GeoProjection, geoPath } from "d3-geo";
import { geoLayer, projectVisiblePoint } from "../geo/index.js";
import { PathRecorder } from "../core/index.js";
import versor, { type Angles, type Vec3, type Quaternion } from "../geo/versor.js";
import { BaseEngine, type HoverHit, type LayerSpec, type InteractiveLayerOptions, type BaseEngineOptions } from "./base-engine.js";
import type { ViewTransform, LineJoin, LineCap } from "../core/index.js";
import { LayerHandle } from "./layer-handle.js";

export interface GeoMapOptions extends BaseEngineOptions {
  projection: GeoProjection;
}
export interface LayerOptions<F = any> extends InteractiveLayerOptions<F> {
  fill?: string | ((f: F, i: number) => string);
  stroke?: string | ((f: F, i: number) => string);
  lineWidth?: number; pointRadius?: number; clipTo?: string;
  /** Stroke corner style: "bevel" (default) | "miter" | "round". Identical across backends. */
  lineJoin?: LineJoin;
  /** Miter length / width above which a miter falls back to a bevel (default 10). */
  miterLimit?: number;
  /** End-cap style for open strokes ("butt" default | "square" | "round"). */
  lineCap?: LineCap;
  id?: (f: F, i: number) => string | number;
  /** "world" (default): radius scales with zoom. "screen": constant pixel size. */
  sizeMode?: "world" | "screen";
  /** Drop this layer from the render while interacting — a rotation drag or a
   *  zoom/pan gesture (re-projects + reappears when the gesture ends). Use for
   *  dense layers so only the cheap layers re-project per rotation frame. */
  hideOnInteraction?: boolean;
  /** When false, skip the CPU hit index for this layer (no hover/pick on it) — saves an
   *  Entry object per feature; use for huge, non-interactive layers (e.g. streamed points). */
  pickable?: boolean;
  /** Render via the backend's pass-through path: no retained Scene geometry, no hit
   *  index (not pickable). Supports all GeoJSON geometry on **both** Canvas and WebGL
   *  (Point/MultiPoint → analytic circles; Polygon/Line/etc. → projected paths) — features
   *  are projected/recorded and drawn directly each repaint, so `features` may be a callback
   *  re-invoked per repaint (you own the data). For huge / fast-changing datasets beyond the
   *  retained ceiling (~4–16M). Trade-off vs the default retained path: retained is always
   *  crisp, interactive, and pickable but capped; pass-through is uncapped + streaming but
   *  shows a slightly stale raster during pan/zoom (re-crisp on settle), isn't pickable, and
   *  re-tessellates non-point geometry per settle. Paths are world-mode (screen-mode paths
   *  are a follow-up). NOTE: `clipTo` is NOT applied to pass-through layers yet — it is ignored
   *  (a follow-up); use the retained path if you need clipping. */
  passThrough?: boolean;
  // selection / hover / tooltip are inherited from InteractiveLayerOptions (shared with Plot).
}

/** Options for {@link GeoMap.enableRotation}. */
export interface RotationOptions {
  /** Wheel-zoom limits as multiples of the fitted scale. Default [0.5, 8]. */
  scaleExtent?: [number, number];
  /** Called with the new `[lambda, phi, gamma]` after each rotation step. */
  onRotate?: (rotation: Angles) => void;
}

interface LayerDef { name: string; opts: LayerOptions; }

/** The object type d3-geo's `fitSize` accepts (Feature / FeatureCollection / geometry / Sphere). */
type FitObject = Parameters<GeoProjection["fitSize"]>[1];

export class GeoMap extends BaseEngine {
  private projection: GeoProjection;
  private defs: LayerDef[] = [];
  /** The projection's fitted scale, captured when the projection is set (NOT re-read on every
   *  interaction dispatch). Rotation wheel-zoom limits are relative to this, so the zoom range
   *  stays anchored to the fitted view across backend swaps and re-dispatches — re-reading the
   *  (already-zoomed) live scale would ratchet the limits and make zooming back out impossible. */
  private baseScale: number;
  /** The last requested interaction, so it can be re-applied (re-dispatched per projection kind)
   *  after a projection switch. */
  private interactionRequest: { extent: [number, number]; onTransform?: (t: ViewTransform) => void } | null = null;

  constructor(host: HTMLElement, opts: GeoMapOptions) {
    super(host, opts);
    this.projection = opts.projection;
    this.baseScale = opts.projection.scale();
  }

  /**
   * Refit the projection into the resized box, then re-project every layer. The caller fitted
   * the projection to the original box (e.g. `projection.fitSize([w,h], …)`); a resize must
   * preserve that framing.
   *
   * - **Uniform resize** (same scale factor on both axes — always true in aspect-ratio mode):
   *   scale the projection's `scale()` + `translate()` by that factor. Projection output is
   *   linear in `scale()`, so this is exact and preserves the caller's framing precisely
   *   (including Sphere fits / padding) with no geometry scan.
   * - **Aspect-ratio change** (fill-parent only): re-letterbox via `fitSize()` against the
   *   engine's own retained geometry (or the Sphere for a spherical projection), reproducing
   *   the caller's fit so the map reflows to fill the new box shape ("meet" framing).
   */
  protected override onResize(prevW: number, prevH: number, w: number, h: number): void {
    if (prevW > 0 && prevH > 0) {
      const fx = w / prevW;
      const fy = h / prevH;
      if (Math.abs(fx - fy) < 1e-6) {
        const [tx, ty] = this.projection.translate();
        this.projection.scale(this.projection.scale() * fx).translate([tx * fx, ty * fy]);
        this.baseScale *= fx;
        this.rebuildLayers();
        return;
      }
    }
    const fit = this.fitObject();
    if (fit) {
      this.projection.fitSize([w, h], fit);
      this.baseScale = this.projection.scale();
    }
    this.rebuildLayers();
  }

  /** The GeoJSON the projection is refitted against on an aspect-ratio change: the Sphere for a
   *  spherical projection (rotation-invariant, the natural globe frame), otherwise the union of
   *  all retained layer geometry (you fit to what you draw). Null when there are no layers yet. */
  private fitObject(): FitObject | null {
    if (this.isSpherical()) return { type: "Sphere" } as FitObject;
    const features: GeoJSON.Feature[] = [];
    for (const def of this.defs) {
      const spec = this.specs.find((s) => s.name === def.name);
      if (!spec) continue;
      for (const datum of spec.data as Array<{ type?: string; geometry?: GeoJSON.Geometry }>) {
        const geometry = (datum.geometry ?? (datum as GeoJSON.Geometry)) as GeoJSON.Geometry;
        if (geometry?.type) features.push({ type: "Feature", geometry, properties: null });
      }
    }
    return features.length ? ({ type: "FeatureCollection", features } as FitObject) : null;
  }

  layer<F>(name: string, features: F | readonly F[] | (() => readonly F[]), opts: LayerOptions<F> = {}): LayerHandle<F> {
    if (opts.passThrough) {
      if (opts.hover || opts.tooltip || opts.selection)
        throw new Error("hover/tooltip/selection require a retained layer (passThrough layers are not pickable)");
      const source: unknown[] | (() => unknown[]) =
        typeof features === "function"
          ? () => [...(features as () => readonly F[])()]
          : [...(Array.isArray(features) ? (features as readonly F[]) : [features as F])];
      const radius = opts.pointRadius ?? 3;
      const lineWidth = opts.lineWidth ?? 0;
      // Color accessors: string | (f,i)=>string, resolved per datum. Points/path fills
      // default to "#000"; a path stroke has no default (null = no stroke).
      const accessor = (
        v: string | ((f: F, i: number) => string) | undefined,
        fallback: string | null,
      ): ((f: F, i: number) => string | null) =>
        typeof v === "function"
          ? (f, i) => (v as (f: F, i: number) => string)(f, i)
          : () => (v as string | undefined) ?? fallback;
      const pointFillOf = accessor(opts.fill, "#000"); // points default to opaque black
      const pathFillOf = accessor(opts.fill, null);     // path fill: null = no fill
      const strokeOf = accessor(opts.stroke, null);     // path stroke: null = no stroke
      this.registerPassThrough({
        name,
        source,
        buildItem: (f, i) => {
          const feature = f as { type?: string; geometry?: GeoJSON.Geometry };
          // Accept a Feature (read .geometry) or a bare Geometry (read the feature itself).
          const geom = (feature.geometry ?? (feature as GeoJSON.Geometry)) as GeoJSON.Geometry;
          const type = geom?.type;
          if (type === "Point") {
            const xy = projectVisiblePoint(this.projection, (geom as GeoJSON.Point).coordinates as [number, number]);
            return xy ? { kind: "points", centers: [xy], radius, color: pointFillOf(f as F, i) ?? "#000" } : null;
          }
          if (type === "MultiPoint") {
            const centers: [number, number][] = [];
            for (const c of (geom as GeoJSON.MultiPoint).coordinates) {
              const xy = projectVisiblePoint(this.projection, c as [number, number]);
              if (xy) centers.push(xy);
            }
            return centers.length > 0 ? { kind: "points", centers, radius, color: pointFillOf(f as F, i) ?? "#000" } : null;
          }
          // Polygon / MultiPolygon / LineString / MultiLineString / GeometryCollection / Feature:
          // record the projected subpaths (same geoPath path as the retained geo layer).
          const rec = new PathRecorder(0.25);
          geoPath(this.projection, rec)(f as Parameters<ReturnType<typeof geoPath>>[0]);
          const subpaths = rec.subpaths.map((s) => ({ closed: s.closed, points: s.points.slice() }));
          if (subpaths.length === 0) return null;
          return { kind: "path", subpaths, fill: pathFillOf(f as F, i), stroke: strokeOf(f as F, i), lineWidth };
        },
        sizeMode: opts.sizeMode,
        clipTo: opts.clipTo,
      });
      return new LayerHandle<F>(this, name, (items) => this.appendPassThrough(name, items as unknown[]));
    }
    if (typeof features === "function") throw new Error("callback data requires passThrough: true");
    const list = Array.isArray(features) ? (features as F[]) : [features as F];
    this.defs = this.defs.filter((d) => d.name !== name).concat({ name, opts });
    this.dropInteractionState(name); // a re-declared layer starts with base styles
    this.registerLayer(this.buildSpec(name, list, opts));
    return new LayerHandle<F>(this, name, (items) => this.appendFeatures(name, items, opts));
  }

  /** Project only the new features against the current projection and append them.
   *  spec.data (extended by appendToLayer) is the rebuild source, so appended
   *  features survive setProjection / rotation. */
  private appendFeatures<F>(name: string, items: readonly F[], opts: LayerOptions<F>): void {
    if (items.length === 0) return;
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    const offset = spec.data.length;
    const ids = items.map((f, j) => (opts.id ? opts.id(f, offset + j) : offset + j));
    const build = geoLayer(items as any[], this.projection, {
      id: (_f, j) => ids[j]!, lineWidth: opts.lineWidth, lineJoin: opts.lineJoin, miterLimit: opts.miterLimit, lineCap: opts.lineCap, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode,
    });
    this.appendToLayer(name, items, ids, build);
  }

  /** Swap the projection on the existing map: re-project every layer once and
   *  reset the affine view to identity (the caller fits the new projection). */
  setProjection(projection: GeoProjection): this {
    this.disableInteraction();          // leave any active zoom/rotation cleanly
    this.projection = projection;
    this.baseScale = projection.scale(); // new fitted reference for rotation zoom limits
    this.rebuildLayers();
    this.setTransform({ k: 1, x: 0, y: 0 });
    const req = this.interactionRequest;
    if (req) this.enableZoom(req.extent, req.onTransform); // re-dispatch for the new projection kind
    return this;
  }

  /** One entry point for both projection kinds: a spherical (azimuthal) projection
   *  gets versor rotation (drag) + wheel-zoom bounded by `extent`; a flat projection
   *  gets d3-zoom affine pan/zoom. `extent` sets the zoom limits for both. Backend-agnostic:
   *  every backend renders the same per-frame-reprojected geometry, so a backend swap needs no
   *  re-dispatch (the interaction listeners and projection state are unaffected by it). */
  override enableZoom(extent: [number, number] = [1, 100], onTransform?: (t: ViewTransform) => void): this {
    this.interactionRequest = { extent, onTransform };
    if (this.isSpherical()) return this.enableRotation({ scaleExtent: extent });
    return super.enableZoom(extent, onTransform);
  }

  /** Azimuthal projections report a positive clipAngle (orthographic 90, stereographic
   *  142, azimuthal* ~180, gnomonic 60); cylindrical/conic report 0. */
  private isSpherical(): boolean {
    const ca = this.projection.clipAngle();
    return ca != null && ca > 0;
  }

  /** Drag to trackball-rotate a spherical projection; wheel to scale it. Re-projects
   *  on the CPU per frame and pushes the result to whatever backend is live, so every
   *  backend (canvas, svg, webgl) renders the identical crisp vector geometry. Layers
   *  flagged hideOnInteraction are hidden mid-gesture so dense data needn't re-project
   *  per frame. (A GPU-side shader-projected globe — no per-frame CPU reprojection — is a
   *  possible future optimization; the backend retains dormant globe-rendering support.) */
  enableRotation(opts: RotationOptions = {}): this {
    this.disableInteraction();
    const host = this.host;
    const [minK, maxK] = opts.scaleExtent ?? [0.5, 8];
    // Anchor zoom limits to the fitted scale captured when the projection was set — NOT the
    // live (possibly already-zoomed) scale — so re-dispatch never ratchets the range.
    const scale0 = this.baseScale;
    let v0: Vec3 | null = null;
    let q0: Quaternion | null = null;
    let r0: Angles = [0, 0, 0];
    let active = false;
    // Wheel zoom has no natural "end"; debounce one so hideOnInteraction layers
    // hide while zooming the globe and re-project once the wheel goes quiet.
    let wheelEnd: ReturnType<typeof setTimeout> | null = null;

    const at = (e: PointerEvent): [number, number] => {
      const r = host.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent): void => {
      const inv = this.projection.invert?.(at(e));
      if (!inv) return;
      v0 = versor.cartesian(inv);
      r0 = this.projection.rotate();
      q0 = versor(r0);
      active = true;
      this.setInteracting(true);
      try { host.setPointerCapture?.(e.pointerId); } catch { /* synthetic event: no active pointer */ }
    };
    const move = (e: PointerEvent): void => {
      if (!active || !v0 || !q0) return;
      const inv = this.projection.rotate(r0).invert?.(at(e));
      if (!inv) return;
      const q1 = versor.multiply(q0, versor.delta(v0, versor.cartesian(inv)));
      const rot = versor.rotation(q1);
      this.projection.rotate(rot);
      this.rebuildLayers({ skipHidden: true });
      opts.onRotate?.(rot);
    };
    const up = (e: PointerEvent): void => {
      if (!active) return;
      active = false;
      // Clear the flag directly (no extra push) so the rebuild below re-projects and
      // re-pushes every layer — including the hidden ones — at the final rotation.
      this.interacting = false;
      try { host.releasePointerCapture?.(e.pointerId); } catch { /* synthetic event: no active pointer */ }
      this.rebuildLayers(); // re-project all (incl. hidden) at the final rotation
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      this.setInteracting(true); // drops hideOnInteraction layers while zooming
      const s = Math.max(scale0 * minK, Math.min(scale0 * maxK, this.projection.scale() * Math.exp(-e.deltaY * 0.001)));
      this.projection.scale(s);
      this.rebuildLayers({ skipHidden: true });
      if (wheelEnd) clearTimeout(wheelEnd);
      wheelEnd = setTimeout(() => {
        wheelEnd = null;
        this.interacting = false;
        this.rebuildLayers(); // re-project all (incl. hidden) once the wheel settles
      }, 200);
    };

    host.addEventListener("pointerdown", down);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
    host.addEventListener("pointercancel", up);
    host.addEventListener("wheel", wheel, { passive: false });
    this.setInteractionCleanup(() => {
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      host.removeEventListener("pointercancel", up);
      host.removeEventListener("wheel", wheel);
      if (wheelEnd) clearTimeout(wheelEnd);
    });
    return this;
  }

  /** Re-register layers against the current projection (re-project once). During a
   *  rotation drag, skipHidden avoids re-projecting hideOnInteraction layers. */
  private rebuildLayers(o: { skipHidden?: boolean } = {}): void {
    for (const def of this.defs) {
      if (o.skipHidden && def.opts.hideOnInteraction) continue;
      const spec = this.specs.find((s) => s.name === def.name);
      if (!spec) continue;
      this.registerLayer(this.buildSpec(def.name, spec.data, def.opts));
    }
  }

  private buildSpec(name: string, list: any[], opts: LayerOptions): LayerSpec {
    const ids = list.map((f, i) => (opts.id ? opts.id(f, i) : i));
    return {
      name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo,
      sizeMode: opts.sizeMode, hideOnInteraction: opts.hideOnInteraction, pickable: opts.pickable,
      ...this.interactionFields(opts),
      build: geoLayer(list, this.projection, { id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, lineJoin: opts.lineJoin, miterLimit: opts.miterLimit, lineCap: opts.lineCap, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode }),
    };
  }
}
export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap { return new GeoMap(host, opts); }
export type { HoverHit };
