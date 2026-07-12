import { type GeoProjection, geoPath } from "d3-geo";
import { geoLayer, projectVisiblePoint, type GeoInput } from "../geo/index.js";
import { PathRecorder } from "../core/index.js";
import versor, { type Angles, type Vec3, type Quaternion } from "../geo/versor.js";
import { BaseEngine, type HoverHit, type LayerSpec, type InteractiveLayerOptions, type BaseEngineOptions, type DataLabelOptions } from "./base-engine.js";
import type { ViewTransform, LineJoin, LineCap } from "../core/index.js";
import { LayerHandle } from "./layer-handle.js";

export interface GeoMapOptions extends BaseEngineOptions {
  projection: GeoProjection;
}
export interface LayerOptions<F extends GeoInput = GeoInput> extends InteractiveLayerOptions<F> {
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

/**
 * Retained per-retained-layer record for re-projection (setProjection / rotation / resize).
 * `rebuild` is a closure that re-registers the layer against the CURRENT projection — it
 * captures the layer's datum type `F` (and its data array reference, which `appendToLayer`
 * mutates in place), so the datum-erased engine store never has to recover `F`: the same
 * existential seam as Plot's per-layer sync closures (#221). `fitData` is that same live
 * array, read GeoInput-typed by {@link GeoMap.fitObject}; `hideOnInteraction` gates the
 * skip-hidden rotation pass without re-reading the (erased) options.
 */
interface LayerDef {
  name: string;
  hideOnInteraction: boolean;
  rebuild: () => void;
  fitData: readonly GeoInput[];
}

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
   * Show engine-owned text labels (#223): supply the data and d3-style accessors, and the engine
   * measures each label's text once, then places + culls collisions and re-places them on every
   * pan/zoom (no manual overlay, transform callback, or text-metric estimates). `anchorOf` returns a
   * PROJECTED point — e.g. `projection(feature.geometry.coordinates)` (return `null` to skip a
   * feature off the globe). Rendered by the active backend — an HTML overlay on WebGL, native
   * `<text>`/`fillText` on SVG/Canvas so labels survive `toSVG()`/`toPNG()` export. Pass `false` to
   * remove; re-call to rebuild after the projection changes.
   */
  labels(data: false): this;
  labels<D>(data: readonly D[], opts: DataLabelOptions<D>): this;
  labels<D>(data: readonly D[] | false, opts?: DataLabelOptions<D>): this {
    this.setDataLabels(data, opts);
    return this;
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
      for (const datum of def.fitData) {
        // A Feature carries its geometry under `.geometry`; a bare Geometry IS the geometry.
        const geometry = "geometry" in datum ? datum.geometry : (datum as GeoJSON.Geometry);
        if (geometry?.type) features.push({ type: "Feature", geometry, properties: null });
      }
    }
    return features.length ? ({ type: "FeatureCollection", features } as FitObject) : null;
  }

  /**
   * Declare (or re-declare) a named layer of GeoJSON `features`, projected once through the
   * map's projection and retained so every backend re-renders the same crisp vector geometry.
   * `features` may be a single Feature/geometry, an array of them, or — only with
   * `passThrough: true` — a callback re-invoked each repaint (the uncapped, non-pickable
   * streaming path). Re-declaring an existing `name` replaces the layer and resets its
   * interaction/style state. Returns a {@link LayerHandle} for appending data and per-layer
   * styling. (Wind exterior polygon rings clockwise in `[lon, lat]` — see the project docs.)
   *
   * @typeParam F - the feature/datum type carried through to accessors and hit results.
   */
  layer<F extends GeoInput>(name: string, features: F | readonly F[] | (() => readonly F[]), opts: LayerOptions<F> = {}): LayerHandle<F> {
    if (opts.passThrough) {
      if (opts.hover || opts.tooltip || opts.selection)
        throw new Error("hover/tooltip/selection require a retained layer (passThrough layers are not pickable)");
      const source: readonly F[] | (() => readonly F[]) =
        typeof features === "function"
          ? () => [...features()]
          : [...(Array.isArray(features) ? features : [features])];
      const radius = opts.pointRadius ?? 3;
      const lineWidth = opts.lineWidth ?? 0;
      // Color accessors: string | (f,i)=>string, resolved per datum. Points/path fills
      // default to "#000"; a path stroke has no default (null = no stroke).
      const accessor = (
        v: string | ((f: F, i: number) => string) | undefined,
        fallback: string | null,
      ): ((f: F, i: number) => string | null) =>
        typeof v === "function" ? v : () => v ?? fallback;
      const pointFillOf = accessor(opts.fill, "#000"); // points default to opaque black
      const pathFillOf = accessor(opts.fill, null);     // path fill: null = no fill
      const strokeOf = accessor(opts.stroke, null);     // path stroke: null = no stroke
      this.registerPassThrough<F>({
        name,
        source,
        buildItem: (f, i) => {
          // Accept a Feature (read .geometry) or a bare Geometry (the feature itself). The
          // downstream geometry-kind casts are GeoJSON-typing boundaries (a discriminated
          // walk d3-geo's own typings don't narrow structurally), not datum erasure.
          const geom: GeoJSON.Geometry = "geometry" in f ? f.geometry : (f as GeoJSON.Geometry);
          const type = geom?.type;
          if (type === "Point") {
            const xy = projectVisiblePoint(this.projection, (geom as GeoJSON.Point).coordinates as [number, number]);
            return xy ? { kind: "points", centers: [xy], radius, color: pointFillOf(f, i) ?? "#000" } : null;
          }
          if (type === "MultiPoint") {
            const centers: [number, number][] = [];
            for (const c of (geom as GeoJSON.MultiPoint).coordinates) {
              const xy = projectVisiblePoint(this.projection, c as [number, number]);
              if (xy) centers.push(xy);
            }
            return centers.length > 0 ? { kind: "points", centers, radius, color: pointFillOf(f, i) ?? "#000" } : null;
          }
          // Polygon / MultiPolygon / LineString / MultiLineString / GeometryCollection / Feature:
          // record the projected subpaths (same geoPath path as the retained geo layer).
          const rec = new PathRecorder(0.25);
          geoPath(this.projection, rec)(f as Parameters<ReturnType<typeof geoPath>>[0]);
          const subpaths = rec.subpaths.map((s) => ({ closed: s.closed, points: s.points.slice() }));
          if (subpaths.length === 0) return null;
          return { kind: "path", subpaths, fill: pathFillOf(f, i), stroke: strokeOf(f, i), lineWidth };
        },
        sizeMode: opts.sizeMode,
        clipTo: opts.clipTo,
      });
      return new LayerHandle<F>(this, name, (items) => this.appendPassThrough(name, items as unknown[]));
    }
    if (typeof features === "function") throw new Error("callback data requires passThrough: true");
    const list: F[] = Array.isArray(features) ? [...features] : [features];
    this.dropInteractionState(name); // a re-declared layer starts with base styles
    // Capture a datum-typed rebuild closure (re-projects against the CURRENT projection) and the
    // live data array — so setProjection/rotation/resize re-register without recovering F from the
    // engine's datum-erased store (#221). `list` is the same reference appendToLayer extends.
    this.defs = this.defs.filter((d) => d.name !== name).concat({
      name,
      hideOnInteraction: !!opts.hideOnInteraction,
      rebuild: () => this.registerLayer(this.buildSpec(name, list, opts)),
      fitData: list,
    });
    this.registerLayer(this.buildSpec(name, list, opts));
    return new LayerHandle<F>(this, name, (items) => this.appendFeatures(name, items, opts));
  }

  /** Project only the new features against the current projection and append them.
   *  spec.data (extended by appendToLayer) is the rebuild source, so appended
   *  features survive setProjection / rotation. */
  private appendFeatures<F extends GeoInput>(name: string, items: readonly F[], opts: LayerOptions<F>): void {
    if (items.length === 0) return;
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    const offset = spec.data.length;
    const ids = items.map((f, j) => (opts.id ? opts.id(f, offset + j) : offset + j));
    const build = geoLayer(items, this.projection, {
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
      if (o.skipHidden && def.hideOnInteraction) continue;
      // The rebuild closure re-registers this layer's typed data against the current projection.
      def.rebuild();
    }
  }

  private buildSpec<F extends GeoInput>(name: string, list: F[], opts: LayerOptions<F>): LayerSpec<F> {
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
