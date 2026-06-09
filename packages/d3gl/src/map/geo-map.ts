import { type GeoProjection, geoEquirectangular, geoPath } from "d3-geo";
import { geoLayer, projectVisiblePoint } from "../geo/index.js";
import { PathRecorder } from "../core/index.js";
import { isOrthographic, rotationMatrix } from "../geo/orthographic.js";
import versor, { type Angles, type Vec3, type Quaternion } from "../geo/versor.js";
import { BaseEngine, type HoverHit, type LayerSpec } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";
import type { ViewTransform } from "../core/index.js";
import { LayerHandle } from "./layer-handle.js";

export interface GeoMapOptions {
  width: number;
  height: number;
  projection: GeoProjection;
  /** Which renderer to draw with — see {@link BackendType}. Defaults to `"webgl"`.
   *  Use `"auto"` for an instant Canvas first paint that upgrades to WebGL in the background. */
  backend?: BackendType;
}
export interface LayerOptions<F = any> {
  fill?: string | ((f: F, i: number) => string);
  stroke?: string | ((f: F, i: number) => string);
  lineWidth?: number; pointRadius?: number; clipTo?: string;
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
}

/** Options for {@link GeoMap.enableRotation}. */
export interface RotationOptions {
  /** Wheel-zoom limits as multiples of the fitted scale. Default [0.5, 8]. */
  scaleExtent?: [number, number];
  /** Called with the new `[lambda, phi, gamma]` after each rotation step. */
  onRotate?: (rotation: Angles) => void;
}

interface LayerDef { name: string; opts: LayerOptions; }

/** WebGL-only globe methods, feature-detected at runtime (other backends lack them). */
type GlobeBackend = {
  setGlobeMode(on: boolean, w?: number, h?: number): void;
  setGlobeRotation(m: Float32Array): void;
};

export class GeoMap extends BaseEngine {
  private projection: GeoProjection;
  private defs: LayerDef[] = [];
  /** True when the backend is WebGL and the projection is orthographic: rotation is
   *  driven on the GPU (bake layers to an equirect texture, spin a textured sphere). */
  private gpuGlobe = false;
  /** While baking, layers are projected with THIS (equirect) instead of this.projection. */
  private bakeProjection: GeoProjection | null = null;
  /** The last requested interaction, so it can be re-applied (re-dispatched CPU vs GPU)
   *  after a projection or backend switch. */
  private interactionRequest: { extent: [number, number]; onTransform?: (t: ViewTransform) => void } | null = null;

  /** Null-safe accessor for the WebGL globe backend (null before the async backend resolves). */
  private globeBackend(): Partial<GlobeBackend> | null {
    const b = this.backend();
    return b ? (b as Partial<GlobeBackend>) : null;
  }

  constructor(host: HTMLElement, opts: GeoMapOptions) {
    super(host, opts.width, opts.height, opts.backend ?? "webgl");
    this.projection = opts.projection;
    this.evalGpuGlobe();
  }

  private evalGpuGlobe(): void {
    this.gpuGlobe = this.backendType() === "webgl" && isOrthographic(this.projection);
  }

  layer<F>(name: string, features: F | readonly F[] | (() => readonly F[]), opts: LayerOptions<F> = {}): LayerHandle<F> {
    if (opts.passThrough) {
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
      id: (_f, j) => ids[j]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode,
    });
    this.appendToLayer(name, items, ids, build);
  }

  /** Swap the projection on the existing map: re-project every layer once and
   *  reset the affine view to identity (the caller fits the new projection). */
  setProjection(projection: GeoProjection): this {
    this.disableInteraction();          // leave any active globe/zoom cleanly
    this.projection = projection;
    this.evalGpuGlobe();
    this.rebuildLayers();
    this.setTransform({ k: 1, x: 0, y: 0 });
    const req = this.interactionRequest;
    if (req) this.enableZoom(req.extent, req.onTransform); // re-dispatch for the new projection
    return this;
  }

  override setBackend(type: BackendType): this {
    // Already live on this backend (e.g. "auto" finished upgrading to WebGL) → do nothing.
    // Must short-circuit BEFORE disableInteraction, or we'd tear down the GPU globe (drop it
    // to the flat fitted disc) and re-bake it — the visible flicker we're avoiding.
    if (this.isCurrentBackend(type)) return this;
    this.disableInteraction();
    super.setBackend(type);
    // gpuGlobe re-eval + interaction re-dispatch now happen in onBackendSwapped(), once the
    // new backend is actually live — which also covers the transparent "auto" canvas→WebGL
    // upgrade (a swap the caller never explicitly requested).
    return this;
  }

  /** After any backend SWAP (explicit setBackend, or the "auto" canvas→WebGL upgrade): the
   *  live backend changed, so re-evaluate GPU-globe eligibility and re-dispatch the stored
   *  interaction (an orthographic globe switches from CPU rotation to the GPU globe on the
   *  swap to WebGL). */
  protected override onBackendSwapped(): void {
    this.evalGpuGlobe();
    const req = this.interactionRequest;
    if (req) this.enableZoom(req.extent, req.onTransform);
  }

  /** One entry point for both projection kinds: a spherical (azimuthal) projection
   *  gets versor rotation (drag) + wheel-zoom bounded by `extent`; a flat projection
   *  gets d3-zoom affine pan/zoom. `extent` sets the zoom limits for both. */
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
   *  on the CPU per frame. Layers flagged hideOnInteraction are hidden mid-drag. */
  enableRotation(opts: RotationOptions = {}): this {
    this.disableInteraction();
    if (this.gpuGlobe) return this.enableGpuGlobe(opts);
    const host = this.host;
    const [minK, maxK] = opts.scaleExtent ?? [0.5, 8];
    const scale0 = this.projection.scale();
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

  /** GPU globe path: bake every layer once into an equirect texture, then drive the
   *  textured sphere's rotation uniform on drag (no per-frame re-tessellation). Wheel
   *  zoom scales the sphere via the view transform and re-bakes at higher resolution
   *  only when crossing a power-of-2 boundary. */
  private enableGpuGlobe(opts: RotationOptions): this {
    const host = this.host;
    const [minK, maxK] = opts.scaleExtent ?? [0.5, 8];
    const BASE_W = 2048, BASE_H = 1024;
    const maxLevel = (() => { let l = 0; while (BASE_W << (l + 1) <= 8192) l++; return l; })();
    let level = 0;
    let texW = BASE_W, texH = BASE_H;
    let viewScale = 1;
    let rebakeTimer: ReturnType<typeof setTimeout> | null = null;
    // The backend may not have resolved yet (enableZoom can be called synchronously
    // right after geoMap(...)); defer backend-dependent init via whenReady(). Cancelled
    // if the interaction is torn down before the backend is ready.
    let cancelled = false;

    const applyBake = (): void => {
      this.bakeProjection = geoEquirectangular().fitSize([texW, texH], { type: "Sphere" });
      this.rebuildLayers(); // re-register every layer via buildSpec → now equirect
      this.bakeProjection = null; // back to orthographic state for future CPU use / cleanup
      this.globeBackend()?.setGlobeMode?.(true, texW, texH);
    };

    // --- versor trackball (same math as the CPU path; only the per-frame effect differs) ---
    let v0: Vec3 | null = null;
    let q0: Quaternion | null = null;
    let r0: Angles = [0, 0, 0];
    let active = false;
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
      try { host.setPointerCapture?.(e.pointerId); } catch { /* synthetic event: no active pointer */ }
    };
    const move = (e: PointerEvent): void => {
      if (!active || !v0 || !q0) return;
      const inv = this.projection.rotate(r0).invert?.(at(e));
      if (!inv) return;
      const q1 = versor.multiply(q0, versor.delta(v0, versor.cartesian(inv)));
      const rot = versor.rotation(q1);
      this.projection.rotate(rot); // keep rotation as state; the GPU sphere shows it
      this.globeBackend()?.setGlobeRotation?.(rotationMatrix(rot));
      opts.onRotate?.(rot);
    };
    const up = (e: PointerEvent): void => {
      if (!active) return;
      active = false;
      try { host.releasePointerCapture?.(e.pointerId); } catch { /* synthetic event: no active pointer */ }
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      viewScale = Math.max(minK, Math.min(maxK, viewScale * Math.exp(-e.deltaY * 0.001)));
      this.setTransform({ k: viewScale, x: 0, y: 0 }); // globe draw scales the sphere by k
      const newLevel = Math.max(0, Math.min(maxLevel, Math.floor(Math.log2(viewScale))));
      if (newLevel !== level) {
        if (rebakeTimer) clearTimeout(rebakeTimer);
        rebakeTimer = setTimeout(() => {
          rebakeTimer = null;
          level = newLevel;
          texW = BASE_W << level; texH = BASE_H << level;
          applyBake();
          this.render();
        }, 200);
      }
    };

    host.addEventListener("pointerdown", down);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
    host.addEventListener("pointercancel", up);
    host.addEventListener("wheel", wheel, { passive: false });
    this.setInteractionCleanup(() => {
      cancelled = true;
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      host.removeEventListener("pointercancel", up);
      host.removeEventListener("wheel", wheel);
      if (rebakeTimer) clearTimeout(rebakeTimer);
      this.globeBackend()?.setGlobeMode?.(false);
      this.bakeProjection = null;
      this.rebuildLayers(); // restore normal orthographic geometry
      this.setTransform({ k: 1, x: 0, y: 0 });
    });

    void this.whenReady().then(() => {
      if (cancelled) return;
      applyBake();
      this.globeBackend()?.setGlobeRotation?.(rotationMatrix(this.projection.rotate()));
      this.render();
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
      build: geoLayer(list, this.bakeProjection ?? this.projection, { id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode }),
    };
  }
}
export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap { return new GeoMap(host, opts); }
export type { HoverHit };
