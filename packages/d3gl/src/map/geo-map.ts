import { type GeoProjection, geoEquirectangular } from "d3-geo";
import { geoLayer } from "../geo/index.js";
import { isOrthographic, rotationMatrix } from "../geo/orthographic.js";
import versor, { type Angles, type Vec3, type Quaternion } from "../geo/versor.js";
import { BaseEngine, type HoverHit, type LayerSpec } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";
import type { ViewTransform } from "../core/index.js";

export interface GeoMapOptions { width: number; height: number; projection: GeoProjection; backend?: BackendType; }
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
}

/** Options for {@link GeoMap.enableRotation}. */
export interface RotationOptions {
  /** Wheel-zoom limits as multiples of the fitted scale. Default [0.5, 8]. */
  scaleExtent?: [number, number];
  /** Called with the new `[lambda, phi, gamma]` after each rotation step. */
  onRotate?: (rotation: Angles) => void;
}

interface LayerDef { name: string; list: any[]; opts: LayerOptions; }

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

  layer<F>(name: string, features: F | readonly F[], opts: LayerOptions<F> = {}): this {
    const list = Array.isArray(features) ? (features as F[]) : [features as F];
    this.defs = this.defs.filter((d) => d.name !== name).concat({ name, list, opts });
    this.registerLayer(this.buildSpec(name, list, opts));
    return this;
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
    this.disableInteraction();
    super.setBackend(type);
    this.evalGpuGlobe();
    const req = this.interactionRequest;
    if (req) this.enableZoom(req.extent, req.onTransform);
    return this;
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
      this.registerLayer(this.buildSpec(def.name, def.list, def.opts));
    }
  }

  private buildSpec(name: string, list: any[], opts: LayerOptions): LayerSpec {
    const ids = list.map((f, i) => (opts.id ? opts.id(f, i) : i));
    return {
      name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo,
      sizeMode: opts.sizeMode, hideOnInteraction: opts.hideOnInteraction,
      build: geoLayer(list, this.bakeProjection ?? this.projection, { id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode }),
    };
  }
}
export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap { return new GeoMap(host, opts); }
export type { HoverHit };
