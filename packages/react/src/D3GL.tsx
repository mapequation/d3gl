import React, { useEffect, useRef } from "react";
import type { GroupBuffers } from "@d3gl/core";
import type { ViewTransform } from "@d3gl/webgl";
import { MapController } from "./controller.js";

export interface D3GLGroup {
  name: string;
  buffers: GroupBuffers;
}

export interface D3GLProps {
  width: number;
  height: number;
  transform?: ViewTransform;
  groups?: D3GLGroup[];
  onReady?: (controller: MapController) => void;
  onError?: (err: unknown) => void;
  className?: string;
}

/**
 * A canvas-backed GPU map. The effect creates a MapController, applies the
 * initial groups + transform, renders, and reports the controller via onReady.
 * Group and transform prop changes are pushed to the controller without rebuild
 * (recolor = texture write, pan/zoom = uniform). Recreated only when size changes.
 */
export function D3GL(props: D3GLProps): React.ReactElement {
  const { width, height, transform, groups, onReady, onError, className } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<MapController | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    MapController.create(canvas, { width, height })
      .then((controller) => {
        if (cancelled) {
          controller.destroy();
          return;
        }
        controllerRef.current = controller;
        for (const g of groups ?? []) controller.setGroup(g.name, g.buffers);
        if (transform) controller.setTransform(transform);
        controller.render();
        onReady?.(controller);
      })
      .catch((err) => {
        if (!cancelled) onError?.(err);
      });
    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
    // Recreate the device only when the canvas size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  useEffect(() => {
    const c = controllerRef.current;
    if (!c || !transform) return;
    c.setTransform(transform);
    c.render();
  }, [transform]);

  useEffect(() => {
    const c = controllerRef.current;
    if (!c) return;
    for (const g of groups ?? []) c.setGroup(g.name, g.buffers);
    c.render();
  }, [groups]);

  return <canvas ref={canvasRef} width={width} height={height} className={className} />;
}
