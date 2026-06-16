import React, { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { GeoProjection } from "d3-geo";
import { geoMap, type GeoMap as Engine, type BackendType, type HoverHit } from "../map/index.js";
import type { ViewTransform } from "../core/index.js";
import { hostSizeStyle, isFixedSize } from "./host-style.js";

export interface GeoMapProps {
  /** Fixed width (px). Omit (with `height`) for responsive sizing. */
  width?: number;
  /** Fixed height (px). Omit (with `width`) for responsive sizing. */
  height?: number;
  /** width ÷ height. When set, the map fills its parent's width and keeps this ratio (the host
   *  resizes the engine in place, refitting the projection). Omit all three to fill the parent box. */
  aspectRatio?: number;
  projection: GeoProjection;
  backend?: BackendType;
  transform?: ViewTransform;
  onReady?: (map: Engine) => void;
  onHover?: (hit: HoverHit | null, ev: PointerEvent) => void;
  className?: string;
  style?: CSSProperties;
}

export function GeoMap(props: GeoMapProps): React.ReactElement {
  const { width, height, aspectRatio, projection, backend, transform, onReady, onHover, className, style } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Engine | null>(null);
  // The backend the engine was created with; the backend effect skips switching
  // to this same value on mount (which would race a second backend creation).
  const createdBackend = useRef<BackendType>(backend ?? "webgl");
  // Latest projection, read at create time. Held in a ref so a new projection object identity
  // on an unrelated re-render (e.g. switching backend, when callers commonly pass
  // `fitProjection(...)` inline) does NOT recreate the engine and lose the current zoom/pan.
  const projectionRef = useRef(projection);
  projectionRef.current = projection;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    createdBackend.current = backend ?? "webgl";
    const map = geoMap(host, { width, height, aspectRatio, projection: projectionRef.current, backend: createdBackend.current });
    mapRef.current = map;
    if (onHover) map.on("hover", onHover);
    let cancelled = false;
    map.whenReady().then(() => {
      if (cancelled) return;
      if (transform) map.setTransform(transform);
      onReady?.(map);
    });
    return () => { cancelled = true; map.destroy(); mapRef.current = null; };
    // Create ONCE on mount. Sizing is handled in place afterwards — responsive modes via the
    // engine's own ResizeObserver (which refits the projection), a fixed-size prop change via
    // the setSize effect below — so a resize never recreates the engine (which would lose
    // zoom/pan, layers, hover/selection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fixed-size prop change → resize in place (responsive modes self-track via ResizeObserver).
  useEffect(() => {
    const map = mapRef.current;
    if (map && isFixedSize(width, height, aspectRatio)) map.setSize(width!, height!);
  }, [width, height, aspectRatio]);

  useEffect(() => {
    const map = mapRef.current;
    // Skip the no-op switch to the backend the engine was just created with.
    if (!map || !backend || backend === createdBackend.current) return;
    createdBackend.current = backend;
    map.setBackend(backend);
  }, [backend]);
  useEffect(() => { if (transform) mapRef.current?.setTransform(transform); }, [transform]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ position: "relative", ...hostSizeStyle(width, height, aspectRatio), ...style }}
    />
  );
}
