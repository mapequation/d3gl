import React, { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { GeoProjection } from "d3-geo";
import { geoMap, type GeoMap as Engine, type BackendType, type HoverHit } from "@d3gl/map";
import type { ViewTransform } from "@d3gl/core";

export interface GeoMapProps {
  width: number;
  height: number;
  projection: GeoProjection;
  backend?: BackendType;
  transform?: ViewTransform;
  onReady?: (map: Engine) => void;
  onHover?: (hit: HoverHit | null, ev: PointerEvent) => void;
  className?: string;
  style?: CSSProperties;
}

export function GeoMap(props: GeoMapProps): React.ReactElement {
  const { width, height, projection, backend, transform, onReady, onHover, className, style } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Engine | null>(null);
  // The backend the engine was created with; the backend effect skips switching
  // to this same value on mount (which would race a second backend creation).
  const createdBackend = useRef<BackendType>(backend ?? "webgl");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    createdBackend.current = backend ?? "webgl";
    const map = geoMap(host, { width, height, projection, backend: createdBackend.current });
    mapRef.current = map;
    if (onHover) map.on("hover", onHover);
    let cancelled = false;
    map.whenReady().then(() => {
      if (cancelled) return;
      if (transform) map.setTransform(transform);
      onReady?.(map);
    });
    return () => { cancelled = true; map.destroy(); mapRef.current = null; };
    // Recreate only on size/projection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, projection]);

  useEffect(() => {
    const map = mapRef.current;
    // Skip the no-op switch to the backend the engine was just created with.
    if (!map || !backend || backend === createdBackend.current) return;
    createdBackend.current = backend;
    map.setBackend(backend);
  }, [backend]);
  useEffect(() => { if (transform) mapRef.current?.setTransform(transform); }, [transform]);

  return <div ref={hostRef} className={className} style={{ position: "relative", width, height, ...style }} />;
}
