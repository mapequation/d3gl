import React, { useEffect, useMemo, useRef, useState } from "react";
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
      id: (_g: unknown, i: number) => cells[i]!.id,
      fill: (_g: unknown, i: number) => cellColor(cells[i]!, modeRef.current),
      lineWidth: 0.2,
      stroke: "#0003",
      clipTo: clip ? "land" : undefined,
    });
    map.layer("route", [makeRoute()], { stroke: ROUTE, lineWidth: 1.5 });
    map.layer("cities", cities.map((c) => c.geometry), { id: (_g: unknown, i: number) => cities[i]!.id, fill: CITY, pointRadius: 3.5 });
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
