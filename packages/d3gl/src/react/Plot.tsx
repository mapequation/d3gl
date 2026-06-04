import React, { useEffect, useRef } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import {
  plot,
  type Plot as Engine,
  type BackendType,
  type PlotLayerOptions,
  type PlotPointOptions,
} from "../map/index.js";

/**
 * Props for a {@link Layer} child of {@link Plot}: the imperative
 * `engine.layer(name, data, opts)` arguments expressed declaratively.
 */
export interface LayerProps<D = unknown> extends PlotLayerOptions<D> {
  name: string;
  data: readonly D[];
}

/**
 * Props for a {@link Points} child of {@link Plot}: the imperative
 * `engine.points(name, data, opts)` arguments expressed declaratively.
 */
export interface PointsProps<D = unknown> extends PlotPointOptions<D> {
  name: string;
  data: readonly D[];
}

/**
 * Declarative layer marker. Renders nothing; {@link Plot} reads its props and
 * calls `engine.layer(name, data, …)`. Sibling order = paint order.
 */
export function Layer<D = unknown>(_props: LayerProps<D>): ReactElement | null {
  return null;
}

/**
 * Declarative point-set marker. Renders nothing; {@link Plot} reads its props and
 * calls `engine.points(name, data, …)`. Sibling order = paint order.
 */
export function Points<D = unknown>(_props: PointsProps<D>): ReactElement | null {
  return null;
}

export interface PlotProps {
  width: number;
  height: number;
  backend?: BackendType;
  /** Enable scroll-to-zoom / drag-to-pan, clamped to this `[min, max]` scale extent. */
  zoom?: [number, number];
  /** Fires after each pan/zoom with the current view transform (k, x, y). */
  onTransform?: (t: { k: number; x: number; y: number }) => void;
  /** Called once the engine is built, its layers applied, and the first frame drawn. */
  onReady?: (engine: Engine) => void;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

interface ChildSpec {
  kind: "layer" | "points";
  props: LayerProps | PointsProps;
}

/** Read `<Layer>` / `<Points>` children into an ordered list of specs (paint order). */
function readChildren(children: ReactNode): ChildSpec[] {
  const specs: ChildSpec[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === Layer) specs.push({ kind: "layer", props: child.props as LayerProps });
    else if (child.type === Points) specs.push({ kind: "points", props: child.props as PointsProps });
  });
  return specs;
}

/** Apply an ordered list of layer/points specs to the engine (order = paint order). */
function applySpecs(engine: Engine, specs: ChildSpec[]): void {
  for (const spec of specs) {
    if (spec.kind === "layer") {
      const { name, data, ...opts } = spec.props as LayerProps;
      engine.layer(name, data, opts);
    } else {
      const { name, data, ...opts } = spec.props as PointsProps;
      engine.points(name, data, opts as PlotPointOptions);
    }
  }
}

/**
 * The declarative non-geo plotting component. It wraps the imperative `plot`
 * engine: an effect keyed on `[width, height]` creates the engine ONCE, reads its
 * `<Layer>` / `<Points>` children and applies them as `engine.layer` / `engine.points`
 * calls (sibling order = paint order), optionally enables zoom, renders, and calls
 * `onReady(engine)`. A `[backend]` effect calls `engine.setBackend()` (preserving the
 * current zoom/pan and layers — no recreate). A children-change effect re-applies the
 * layers/points to the live engine so content updates keep the current view.
 *
 * ```tsx
 * <Plot width={w} height={h} backend={backend} zoom={[0.5, 40]} onReady={register}>
 *   <Layer name="links" data={links} draw={(ctx, l) => { gen.context(ctx); gen(l); }} stroke="#555" />
 *   <Points name="nodes" data={tips} x={(n) => n.y} y={(n) => n.x} radius={2.6} fill={colorOf} />
 * </Plot>
 * ```
 */
export function Plot(props: PlotProps): ReactElement {
  const { width, height, backend, zoom, onTransform, onReady, className, style, children } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  // The backend the engine was created with; the [backend] effect skips the no-op
  // switch to this same value on mount (which would race a second backend creation).
  const createdBackend = useRef<BackendType>(backend ?? "webgl");
  // Read at (re)create time from refs so unrelated re-renders (e.g. switching backend)
  // don't recreate the engine and lose zoom — recreation is keyed on width/height only.
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onTransformRef = useRef(onTransform);
  onTransformRef.current = onTransform;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    createdBackend.current = backend ?? "webgl";
    const engine = plot(host, { width, height, backend: createdBackend.current });
    engineRef.current = engine;
    let cancelled = false;
    engine.whenReady().then(() => {
      if (cancelled) return;
      applySpecs(engine, readChildren(childrenRef.current));
      if (zoomRef.current) engine.enableZoom(zoomRef.current, onTransformRef.current);
      engine.render();
      onReadyRef.current?.(engine);
    });
    return () => {
      cancelled = true;
      engine.destroy();
      engineRef.current = null;
    };
    // Recreate only on size change; everything else is read from refs above so an
    // unrelated re-render doesn't recreate the engine (which would lose zoom/pan).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // Swap backend in place — preserves zoom/pan + layers (no recreate).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !backend || backend === createdBackend.current) return;
    createdBackend.current = backend;
    engine.setBackend(backend);
  }, [backend]);

  // Re-apply layers/points when children change, keeping the live engine (and its view).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    applySpecs(engine, readChildren(children));
    engine.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  return <div ref={hostRef} className={className} style={{ position: "relative", width, height, ...style }} />;
}
