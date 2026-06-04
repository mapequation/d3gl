import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import type { GeoMap as Engine } from "@mapequation/d3gl/map";
import type { ExampleHandle, ExampleOptions, ExampleSize } from "../types.js";
import Component from "./WorldMapReact.tsx";

/**
 * Mounts the React `<GeoMap>` world map through the SAME ExampleFrame pipeline as the
 * vanilla examples: the shared Astro control bar drives `backend`/size via props. A
 * backend switch re-renders the component with the new `backend` prop, whose `[backend]`
 * effect calls `engine.setBackend()` (preserving zoom/pan) — no remount.
 */
export function mount(el: HTMLElement, opts: ExampleOptions, size: ExampleSize): ExampleHandle {
  let engine: Engine | null = null;
  let currentBackend = opts.backend;
  const root: Root = createRoot(el);
  const render = (): void => {
    root.render(createElement(Component, {
      backend: currentBackend,
      width: size.width,
      height: size.height,
      onEngine: (e) => { engine = e; },
    }));
  };
  render();

  return {
    dispose: () => root.unmount(),
    setBackend: (b) => { currentBackend = b; render(); },
    exportImage: () =>
      currentBackend === "svg"
        ? { format: "svg", data: engine?.toSVG() ?? "" }
        : { format: "png", data: engine?.toPNG() ?? "" },
  };
}
