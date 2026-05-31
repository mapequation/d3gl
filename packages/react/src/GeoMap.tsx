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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const map = geoMap(host, { width, height, projection, backend: backend ?? "webgl" });
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

  useEffect(() => { if (backend) mapRef.current?.setBackend(backend); }, [backend]);
  useEffect(() => { if (transform) mapRef.current?.setTransform(transform); }, [transform]);

  return <div ref={hostRef} className={className} style={{ position: "relative", width, height, ...style }} />;
}
