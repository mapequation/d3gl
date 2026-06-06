import { type GeoProjection } from "d3-geo";
import { geoLayer } from "../geo/index.js";
import versor, { type Angles, type Vec3, type Quaternion } from "../geo/versor.js";
import { BaseEngine, type HoverHit, type LayerSpec } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";

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

export class GeoMap extends BaseEngine {
  private projection: GeoProjection;
  private defs: LayerDef[] = [];

  constructor(host: HTMLElement, opts: GeoMapOptions) {
    super(host, opts.width, opts.height, opts.backend ?? "webgl");
    this.projection = opts.projection;
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
    this.projection = projection;
    this.rebuildLayers();
    this.setTransform({ k: 1, x: 0, y: 0 });
    return this;
  }

  /** Drag to trackball-rotate a spherical projection; wheel to scale it. Re-projects
   *  on the CPU per frame. Layers flagged hideOnInteraction are hidden mid-drag. */
  enableRotation(opts: RotationOptions = {}): this {
    this.disableInteraction();
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
      host.setPointerCapture?.(e.pointerId);
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
      host.releasePointerCapture?.(e.pointerId);
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
      this.registerLayer(this.buildSpec(def.name, def.list, def.opts));
    }
  }

  private buildSpec(name: string, list: any[], opts: LayerOptions): LayerSpec {
    const ids = list.map((f, i) => (opts.id ? opts.id(f, i) : i));
    return {
      name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo,
      sizeMode: opts.sizeMode, hideOnInteraction: opts.hideOnInteraction,
      build: geoLayer(list, this.projection, { id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode }),
    };
  }
}
export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap { return new GeoMap(host, opts); }
export type { HoverHit };
