import { useEffect, useMemo, useRef, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis, schemeCategory10 } from "d3-scale-chromatic";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent } from "d3-zoom";
import { Scene } from "@d3gl/core";
import { fitProjection, featureGroup, type GeoInput } from "@d3gl/geo";
import { D3GL, type D3GLGroup, type MapController } from "@d3gl/react";
import { SvgPathContext, svgDocument } from "@d3gl/svg";
import {
  makeCells,
  makeCities,
  cityMarkers,
  loadWorld,
  cellsOnLand,
  cellsToFeatureCollection,
  type Cell,
} from "./data.js";

const WIDTH = 900;
const HEIGHT = 450;

const OCEAN = "#0e2238";
const LAND = "#243042";
const CITY = "#ff5a5a";

type Mode = "heatmap" | "bioregion";

const heat = scaleSequential(interpolateViridis).domain([0, 1]);

function cellColor(cell: Cell, mode: Mode): string {
  return mode === "heatmap" ? heat(cell.value) : schemeCategory10[cell.bioregion % 10]!;
}

/** Recolor every cell for the current mode (a texture write, no re-tessellation). */
function applyColors(scene: Scene, cells: readonly Cell[], mode: Mode): void {
  for (const c of cells) scene.setFill("cells", c.id, cellColor(c, mode));
}

/** Show/hide cells: when clipping, only cells whose centroid is on land stay visible. */
function applyClip(scene: Scene, cells: readonly Cell[], onLand: Set<string>, clip: boolean): void {
  for (const c of cells) scene.setFlag("cells", c.id, clip && !onLand.has(c.id) ? 0 : 1);
}

interface Tooltip {
  left: number;
  top: number;
  text: string;
}

export function App(): React.ReactElement {
  const [mode, setMode] = useState<Mode>("heatmap");
  const [clip, setClip] = useState(false);
  const [zoom, setZoom] = useState({ k: 1, x: 0, y: 0 });
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const controllerRef = useRef<MapController | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Build cells, cities, world, projection and scene once. geoPath projects every
  // feature ONCE here; afterwards the GPU recolors, shows/hides, and pans/zooms.
  const { cells, cities, projection, scene, onLand, initialGroups } = useMemo(() => {
    const cells = makeCells();
    const cities = makeCities();
    const world = loadWorld();
    const projection = fitProjection(
      geoNaturalEarth1(),
      cellsToFeatureCollection(cells),
      WIDTH,
      HEIGHT,
    );
    const onLand = cellsOnLand(cells, world.land);

    const scene = new Scene();
    // Background: the ocean sphere then the land outline (different GeoJSON object
    // types — Sphere and MultiPolygon — rendered through the same path pipeline).
    // Sphere isn't part of the strict GeoJSON union, but d3-geo fills it; cast it.
    const background: GeoInput[] = [world.sphere as unknown as GeoInput, world.land];
    scene.group(
      "background",
      featureGroup(background, projection, {
        id: (_geom, i) => (i === 0 ? "ocean" : "land"),
      }),
    );
    scene.setFill("background", "ocean", OCEAN);
    scene.setFill("background", "land", LAND);

    scene.group(
      "cells",
      featureGroup(cells.map((c) => c.geometry), projection, {
        id: (_geom, i) => cells[i]!.id,
        lineWidth: 0.25,
      }),
    );
    applyColors(scene, cells, "heatmap");

    // Cities: Point data, projected to small filled dots via a closed-arc builder.
    scene.group("markers", cityMarkers(cities, projection));
    for (const c of cities) scene.setFill("markers", c.id, CITY);

    const initialGroups: D3GLGroup[] = [
      { name: "background", buffers: scene.buffers("background") },
      { name: "cells", buffers: scene.buffers("cells") },
      { name: "markers", buffers: scene.buffers("markers") },
    ];
    return { cells, cities, projection, scene, onLand, initialGroups };
  }, []);

  // Recolor (mode) and show/hide (clip) — both are texture writes, no re-tessellation.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    applyColors(scene, cells, mode);
    applyClip(scene, cells, onLand, clip);
    controller.updateColors("cells", scene.buffers("cells"));
    controller.render();
  }, [mode, clip, scene, cells, onLand]);

  // Wire d3-zoom on the wrapper -> transform state (the consumer "zoom glue").
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const behavior = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([1, 50])
      .on("zoom", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
        const t = event.transform;
        setZoom({ k: t.k, x: t.x, y: t.y });
      });
    const selection = select(el);
    selection.call(behavior);
    return () => {
      selection.on(".zoom", null);
    };
  }, []);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const controller = controllerRef.current;
    const el = wrapperRef.current;
    if (!controller || !el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Prefer a city under the cursor, then fall back to the grid cell.
    const cityId = controller.pick("markers", x, y);
    if (cityId >= 0 && cityId < cities.length) {
      setTooltip({ left: x + 12, top: y + 12, text: `📍 ${cities[cityId]!.name}` });
      return;
    }
    const id = controller.pick("cells", x, y);
    if (id < 0 || id >= cells.length || (clip && !onLand.has(cells[id]!.id))) {
      setTooltip(null);
      return;
    }
    const cell = cells[id]!;
    setTooltip({
      left: x + 12,
      top: y + 12,
      text: `cell ${cell.id} · value ${cell.value.toFixed(3)} · bioregion ${cell.bioregion}`,
    });
  };

  const exportPNG = (): void => {
    const controller = controllerRef.current;
    if (!controller) return;
    download(controller.toPNG(), "bioregions.png");
  };

  const exportSVG = (): void => {
    const path = (geom: Parameters<ReturnType<typeof geoPath>>[0]): string => {
      const ctx = new SvgPathContext();
      geoPath(projection, ctx)(geom);
      return ctx.toPath();
    };
    const paths = [
      { d: path({ type: "Sphere" }), fill: OCEAN, stroke: "none", strokeWidth: 0 },
      { d: path(loadWorldLand()), fill: LAND, stroke: "none", strokeWidth: 0 },
      ...cells
        .filter((cell) => !clip || onLand.has(cell.id))
        .map((cell) => ({
          d: path(cell.geometry),
          fill: cellColor(cell, mode),
          stroke: "#0003",
          strokeWidth: 0.25,
        })),
      ...cities.map((c) => ({ d: path(c.geometry), fill: CITY, stroke: "none", strokeWidth: 0 })),
    ];
    const svg = svgDocument(WIDTH, HEIGHT, paths);
    download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, "bioregions.svg");
  };

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>d3gl — bioregions mini</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setMode("heatmap")} disabled={mode === "heatmap"}>
          Heatmap
        </button>
        <button onClick={() => setMode("bioregion")} disabled={mode === "bioregion"}>
          Bioregions
        </button>
        <button onClick={() => setClip((c) => !c)}>{clip ? "Unclip" : "Clip to land"}</button>
        <button onClick={exportPNG}>Export PNG</button>
        <button onClick={exportSVG}>Export SVG</button>
        <span style={{ opacity: 0.6, alignSelf: "center" }}>
          scroll to zoom, drag to pan · {cells.length} cells
        </span>
      </div>
      <div
        ref={wrapperRef}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setTooltip(null)}
        style={{ position: "relative", width: WIDTH, height: HEIGHT, background: "#111", cursor: "crosshair" }}
      >
        <D3GL
          width={WIDTH}
          height={HEIGHT}
          transform={zoom}
          groups={initialGroups}
          onReady={(c) => {
            controllerRef.current = c;
          }}
        />
        {tooltip && (
          <div
            style={{
              position: "absolute",
              left: tooltip.left,
              top: tooltip.top,
              pointerEvents: "none",
              background: "rgba(0,0,0,0.85)",
              border: "1px solid #444",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 12,
              whiteSpace: "nowrap",
            }}
          >
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  );
}

// loadWorld() reparses the topology; cache the land geometry for SVG export.
let _land: ReturnType<typeof loadWorld>["land"] | null = null;
function loadWorldLand(): ReturnType<typeof loadWorld>["land"] {
  if (!_land) _land = loadWorld().land;
  return _land;
}

function download(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
}
