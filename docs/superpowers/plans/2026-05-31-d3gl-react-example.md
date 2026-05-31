# d3gl React `<GeoMap>` + example rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A thin React `<GeoMap>` façade over the `geoMap()` engine, plus a rewritten
bioregions example that switches backend (WebGL/Canvas/SVG) live, clips cells to land
(real pixel-accurate clipping), recolors (heatmap/bioregion), zooms, hovers, and renders
**all six** GeoJSON geometry types.

**Architecture:** `<GeoMap>` creates a `GeoMap` engine on mount, pushes `backend`/
`transform` prop changes, wires `onHover`, and hands the instance back via `onReady` so the
app declares layers imperatively (the recommended "imperative core + thin React wrapper"
shape). A small engine addition `setClip(name, clipTo?)` toggles clipping without
re-tessellating.

**Tech stack:** React 19, d3-geo, Vitest browser. This is Plan 4 of 4 — depends on Plan 3
(`@d3gl/map`: `geoMap`, `GeoMap`, `LayerOptions`, `HoverHit`, `BackendType`).

---

### Task 1: `geoMap` engine — `setClip(name, clipTo?)` (`@d3gl/map`)

**Files:**
- Modify: `packages/map/src/geo-map.ts`
- Test: `packages/map/src/set-clip.browser.test.ts`

Context: toggling clip on/off must not re-project/re-tessellate. The engine already stores
`spec.opts` (with `clipTo`); `setClip` mutates it and re-pushes layers using the existing
Scene buffers (`pushLayers()` does not rebuild Scene groups).

- [ ] **Step 1: Write the failing browser test**

```ts
// packages/map/src/set-clip.browser.test.ts
import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap } from "./geo-map.js";

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const poly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

describe("geoMap.setClip", () => {
  it("toggles clipTo on an existing layer without throwing", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [poly(-40, -40, 40)], { fill: "rgb(40,40,40)" });
    map.layer("cells", [poly(-40, -40, 80)], { fill: "rgb(255,0,0)" });
    map.render();
    expect(() => map.setClip("cells", "land")).not.toThrow();
    expect(() => map.setClip("cells", undefined)).not.toThrow();
    map.destroy();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `cd packages/map && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts set-clip` → FAIL (`setClip` not a function).

- [ ] **Step 3: Implement** — add to the `GeoMap` class in `geo-map.ts`:

```ts
/** Toggle/replace a layer's clip source without rebuilding geometry. */
setClip(name: string, clipTo?: string): this {
  const spec = this.specs.find((s) => s.name === name);
  if (!spec) return this;
  spec.opts = { ...spec.opts, clipTo };
  this.pushLayers();
  return this;
}
```

- [ ] **Step 4: Run, verify pass.** Browser test green; full Node suite green.

- [ ] **Step 5: Commit:** `git commit -m "feat(map): geoMap.setClip — toggle layer clipping without re-tessellation"`

---

### Task 2: `<GeoMap>` React component (`@d3gl/react`)

**Files:**
- Create: `packages/react/src/GeoMap.tsx`
- Modify: `packages/react/src/index.ts`, `packages/react/package.json` (add `@d3gl/map`, `d3-geo` types)
- Test: `packages/react/src/GeoMap.browser.test.tsx`

Context: a thin wrapper. It owns a host `<div>`, creates the engine on mount (recreates on
size change), pushes `backend`/`transform` prop changes via effects, wires `onHover`, and
calls `onReady(map)` after `whenReady()` so the consumer declares layers + `enableZoom`
imperatively. The existing `D3GL`/`MapController` stay exported (back-compat); `<GeoMap>` is
the new recommended entry point. Add `@d3gl/map: "workspace:*"` (and dev `@types/d3-geo`,
`d3-geo` for the `GeoProjection` type) to `packages/react/package.json`, then
`corepack pnpm@9.15.9 install`.

- [ ] **Step 1: Write the failing browser test**

```tsx
// packages/react/src/GeoMap.browser.test.tsx
import { describe, it, expect } from "vitest";
import { createRoot } from "react-dom/client";
import { geoEquirectangular } from "d3-geo";
import { GeoMap } from "./GeoMap.js";
import type { GeoMap as Engine } from "@d3gl/map";

describe("<GeoMap>", () => {
  it("mounts, calls onReady with the engine, and renders a canvas", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const ready = new Promise<Engine>((resolve) => {
      root.render(
        <GeoMap width={120} height={120} projection={geoEquirectangular().scale(30).translate([60, 60])} backend="canvas" onReady={(m) => resolve(m)} />,
      );
    });
    const map = await ready;
    expect(map).toBeTruthy();
    map.layer("cells", [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]] } }], { fill: "rgb(255,0,0)" });
    map.render();
    expect(host.querySelector("canvas")).toBeTruthy();
    root.unmount();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `cd packages/react && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts GeoMap` → FAIL.

(If `@d3gl/react` lacks a browser `vitest.config.ts`, it already has one used by the existing
`*.browser.test.tsx` tests — reuse it. Confirm with `ls packages/react/vitest.config.ts`;
if absent, copy `packages/geo/vitest.config.ts` and ensure the glob also matches `.tsx`:
`include: ["src/**/*.browser.test.{ts,tsx}"]`.)

- [ ] **Step 3: Implement** `packages/react/src/GeoMap.tsx`:

```tsx
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
```

Export `GeoMap` and `GeoMapProps` from `packages/react/src/index.ts` (keep existing `D3GL`/
`MapController` exports).

- [ ] **Step 4: Run, verify pass.** Browser test green; existing react browser tests still pass.

- [ ] **Step 5: Commit:** `git commit -m "feat(react): <GeoMap> — thin React wrapper over the geoMap engine"`

---

### Task 3: Rewrite the bioregions example

**Files:**
- Modify: `examples/bioregions/src/data.ts` (add graticule/route/cluster; drop now-unused `cityMarkers`/`cellsOnLand`)
- Rewrite: `examples/bioregions/src/App.tsx`
- Modify: `examples/bioregions/package.json` (add `@d3gl/map`, `@d3gl/canvas`; can drop direct `@d3gl/svg`/`@d3gl/core` if unused), `examples/bioregions/vite.config.ts` (alias `@d3gl/map`)
- Verify: `corepack pnpm@9.15.9 build` (in the example) + headless screenshots (controller will run these)

Context: the example becomes a thin consumer of `<GeoMap>`. It builds layers covering all
six geometry types and exposes backend switch, real clip toggle, heatmap/bioregion toggle,
zoom, hover, and PNG/SVG export. Keep the synthetic grid but use a coarser `STEP` (e.g. 6°,
~1800 cells) so the SVG backend stays interactive.

- [ ] **Step 1: data.ts additions**

Keep `Cell`, `makeCells` (set `STEP = 6`), `cellsToFeatureCollection`, `loadWorld`,
`makeCities`. Remove `cityMarkers` and `cellsOnLand` (real clipping replaces centroid
filtering; points are handled by `geoLayer`). Add:

```ts
import { geoGraticule } from "d3-geo";
import type { LineString, MultiLineString, MultiPoint, Feature } from "geojson";

/** A 20° graticule as one MultiLineString feature. */
export function makeGraticule(): Feature<MultiLineString> {
  return { type: "Feature", properties: {}, geometry: geoGraticule().step([20, 20])() };
}

/** A great-circle-ish route as a LineString feature (London -> New York -> Tokyo). */
export function makeRoute(): Feature<LineString> {
  return {
    type: "Feature", properties: {},
    geometry: { type: "LineString", coordinates: [[-0.13, 51.51], [-74.01, 40.71], [139.69, 35.69]] },
  };
}

/** A cluster of locations as one MultiPoint feature. */
export function makeCluster(): Feature<MultiPoint> {
  return {
    type: "Feature", properties: {},
    geometry: { type: "MultiPoint", coordinates: [[18.42, -33.92], [151.21, -33.87], [-43.2, -22.91], [36.82, -1.29], [72.88, 19.08]] },
  };
}
```

- [ ] **Step 2: App.tsx — full rewrite**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis, schemeCategory10 } from "d3-scale-chromatic";
import { fitProjection } from "@d3gl/geo";
import { GeoMap } from "@d3gl/react";
import type { GeoMap as Engine, HoverHit } from "@d3gl/map";
import type { GeoInput } from "@d3gl/geo";
import { makeCells, makeCities, makeGraticule, makeRoute, makeCluster, cellsToFeatureCollection, loadWorld, type Cell } from "./data.js";

const WIDTH = 900;
const HEIGHT = 450;
const OCEAN = "#0e2238";
const LAND = "#243042";
const GRAT = "#2c3b52";
const ROUTE = "#ffd166";
const CITY = "#ff5a5a";

type Mode = "heatmap" | "bioregion";
type BackendType = "webgl" | "canvas" | "svg";

const heat = scaleSequential(interpolateViridis).domain([0, 1]);
const cellColor = (c: Cell, mode: Mode) => (mode === "heatmap" ? heat(c.value) : schemeCategory10[c.bioregion % 10]!);

export function App(): React.ReactElement {
  const [backend, setBackend] = useState<BackendType>("webgl");
  const [mode, setMode] = useState<Mode>("heatmap");
  const [clip, setClip] = useState(false);
  const [tooltip, setTooltip] = useState<{ left: number; top: number; text: string } | null>(null);

  const mapRef = useRef<Engine | null>(null);
  const modeRef = useRef(mode); modeRef.current = mode;
  const wrapRef = useRef<HTMLDivElement>(null);

  const { cells, cellById, projection } = useMemo(() => {
    const cells = makeCells();
    const projection = fitProjection(geoNaturalEarth1(), cellsToFeatureCollection(cells), WIDTH, HEIGHT);
    const cellById = new Map(cells.map((c) => [c.id, c] as const));
    return { cells, cellById, projection };
  }, []);

  const onReady = (map: Engine): void => {
    mapRef.current = map;
    const world = loadWorld();
    const cities = makeCities();
    // Layer order = paint order: ocean, land(clip source), graticule, cells, route, points.
    map.layer("ocean", [world.sphere as unknown as GeoInput], { fill: OCEAN });
    map.layer("land", [world.land], { fill: LAND });
    map.layer("graticule", [makeGraticule()], { stroke: GRAT, lineWidth: 0.5 });
    map.layer("cells", cells.map((c) => c.geometry), {
      id: (_g, i) => cells[i]!.id,
      fill: (_g, i) => cellColor(cells[i]!, modeRef.current),
      lineWidth: 0.2,
      stroke: "#0003",
      clipTo: clip ? "land" : undefined,
    });
    map.layer("route", [makeRoute()], { stroke: ROUTE, lineWidth: 1.5 });
    map.layer("cities", cities.map((c) => c.geometry), { id: (_g, i) => cities[i]!.id, fill: CITY, pointRadius: 3.5 });
    map.layer("cluster", [makeCluster()], { fill: "#4dd0e1", pointRadius: 3 });
    map.enableZoom([1, 50]);
    map.render();
  };

  useEffect(() => { mapRef.current?.recolor("cells"); }, [mode]);
  useEffect(() => { mapRef.current?.setClip("cells", clip ? "land" : undefined); }, [clip]);

  const onHover = (hit: HoverHit | null, ev: PointerEvent): void => {
    const el = wrapRef.current;
    if (!hit || !el) { setTooltip(null); return; }
    const r = el.getBoundingClientRect();
    const left = ev.clientX - r.left + 12, top = ev.clientY - r.top + 12;
    if (hit.layer === "cells") {
      const c = cellById.get(hit.id as string);
      if (c) setTooltip({ left, top, text: `cell ${c.id} · value ${c.value.toFixed(3)} · bioregion ${c.bioregion}` });
    } else if (hit.layer === "cities") {
      setTooltip({ left, top, text: `📍 ${hit.id}` });
    } else {
      setTooltip({ left, top, text: hit.layer });
    }
  };

  const exportPNG = (): void => {
    try { download(mapRef.current!.toPNG(), "bioregions.png"); }
    catch { alert("PNG export needs the WebGL or Canvas backend."); }
  };
  const exportSVG = (): void => {
    const svg = mapRef.current?.toSVG() ?? "";
    download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, "bioregions.svg");
  };

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>d3gl — bioregions ({backend})</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {(["webgl", "canvas", "svg"] as const).map((b) => (
          <button key={b} onClick={() => setBackend(b)} disabled={backend === b}>{b}</button>
        ))}
        <span style={{ width: 12 }} />
        <button onClick={() => setMode("heatmap")} disabled={mode === "heatmap"}>Heatmap</button>
        <button onClick={() => setMode("bioregion")} disabled={mode === "bioregion"}>Bioregions</button>
        <button onClick={() => setClip((c) => !c)}>{clip ? "Unclip" : "Clip to land"}</button>
        <button onClick={exportPNG}>Export PNG</button>
        <button onClick={exportSVG}>Export SVG</button>
      </div>
      <div ref={wrapRef} style={{ position: "relative", width: WIDTH, height: HEIGHT, background: "#111", cursor: "crosshair" }}>
        <GeoMap width={WIDTH} height={HEIGHT} projection={projection} backend={backend} onReady={onReady} onHover={onHover} />
        {tooltip && (
          <div style={{ position: "absolute", left: tooltip.left, top: tooltip.top, pointerEvents: "none", background: "rgba(0,0,0,0.85)", border: "1px solid #444", borderRadius: 4, padding: "4px 8px", fontSize: 12, whiteSpace: "nowrap" }}>
            {tooltip.text}
          </div>
        )}
      </div>
      <p style={{ opacity: 0.6, fontSize: 12 }}>{cells.length} cells · scroll to zoom, drag to pan · switch backend above (SVG is slower at scale)</p>
    </div>
  );
}

function download(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href; a.download = filename; a.click();
}
```

Note: switching `backend` recreates the engine layers (the `<GeoMap>` effect on `backend`
calls `setBackend`, which re-applies the engine's retained specs — but `onReady` only fires
once, so the layers added in `onReady` persist across backend switches because the engine
keeps `this.specs`). Verify this holds; if a backend switch loses layers, change `<GeoMap>`
to re-run an `onReady`-like callback after each `setBackend` resolve, or have the app
re-add layers. The cleanest fix if needed: add an `onBackendChange`/re-`onReady` after
`setBackend().whenReady()`. Keep the app code above as the target; adjust the wrapper
minimally to guarantee layers survive a backend switch.

- [ ] **Step 3: package.json + vite alias**

Add `"@d3gl/map": "workspace:*"` and `"@d3gl/canvas": "workspace:*"` to
`examples/bioregions/package.json` deps; run `corepack pnpm@9.15.9 install`. In
`examples/bioregions/vite.config.ts`, add `"@d3gl/map": pkg("map")` to the alias map.

- [ ] **Step 4: Build + typecheck.** `cd examples/bioregions && corepack pnpm@9.15.9 typecheck && corepack pnpm@9.15.9 build` → clean.

- [ ] **Step 5: Commit:** `git commit -m "feat(example): rewrite bioregions on <GeoMap> — backend switch, real clip, all 6 geometry types"`

(The controller verifies rendering across backends via headless screenshots after this.)

---

## Self-review notes
- Spec coverage: `<GeoMap>` (imperative-core + thin wrapper) Task 2; example with backend
  switch, real clip toggle (Task 1 `setClip`), recolor, zoom, hover, PNG/SVG, and all six
  geometry types (ocean=Sphere extra; land=MultiPolygon, graticule=MultiLineString,
  cells=Polygon, route=LineString, cities=Point, cluster=MultiPoint) Task 3.
- Backend-switch persistence: the engine retains layer specs, so `setBackend` re-applies
  them. The plan flags verifying this and the minimal wrapper fix if a switch drops layers.
- Type consistency: `<GeoMap>` props use `GeoProjection`/`ViewTransform`/`BackendType`/
  `HoverHit` from the established packages; example uses `fitProjection`/`GeoInput` from geo
  and the engine via the wrapper.
