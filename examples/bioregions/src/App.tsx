import { useEffect, useMemo, useRef, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis, schemeCategory10 } from "d3-scale-chromatic";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent } from "d3-zoom";
import { Scene } from "@d3gl/core";
import { fitProjection, featureGroup } from "@d3gl/geo";
import { D3GL, type MapController } from "@d3gl/react";
import { SvgPathContext, svgDocument } from "@d3gl/svg";
import { makeCells, cellsToFeatureCollection, type Cell } from "./data.js";

const WIDTH = 900;
const HEIGHT = 450;

type Mode = "heatmap" | "bioregion";

const heat = scaleSequential(interpolateViridis).domain([0, 1]);

function cellColor(cell: Cell, mode: Mode): string {
  return mode === "heatmap" ? heat(cell.value) : schemeCategory10[cell.bioregion % 10]!;
}

function applyColors(scene: Scene, cells: readonly Cell[], mode: Mode): void {
  for (const c of cells) scene.setFill("cells", c.id, cellColor(c, mode));
}

interface Tooltip {
  left: number;
  top: number;
  cell: Cell;
}

export function App(): React.ReactElement {
  const [mode, setMode] = useState<Mode>("heatmap");
  const [zoom, setZoom] = useState({ k: 1, x: 0, y: 0 });
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const controllerRef = useRef<MapController | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Build cells + projection + scene once. geoPath projects each cell ONCE here.
  const { cells, projection, scene, initialGroups } = useMemo(() => {
    const cells = makeCells();
    const projection = fitProjection(
      geoNaturalEarth1(),
      cellsToFeatureCollection(cells),
      WIDTH,
      HEIGHT,
    );
    const scene = new Scene();
    scene.group(
      "cells",
      featureGroup(
        cells.map((c) => c.geometry),
        projection,
        { id: (_geom, i) => cells[i]!.id, lineWidth: 0.25 },
      ),
    );
    applyColors(scene, cells, "heatmap");
    const initialGroups = [{ name: "cells", buffers: scene.buffers("cells") }];
    return { cells, projection, scene, initialGroups };
  }, []);

  // Recolor when the mode changes — a texture write, no re-tessellation.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    applyColors(scene, cells, mode);
    controller.updateColors("cells", scene.buffers("cells"));
    controller.render();
  }, [mode, scene, cells]);

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
    const id = controller.pick("cells", x, y);
    if (id < 0 || id >= cells.length) {
      setTooltip(null);
      return;
    }
    setTooltip({ left: x + 12, top: y + 12, cell: cells[id]! });
  };

  const exportPNG = (): void => {
    const controller = controllerRef.current;
    if (!controller) return;
    download(controller.toPNG(), "bioregions.png");
  };

  const exportSVG = (): void => {
    const paths = cells.map((cell) => {
      const ctx = new SvgPathContext();
      geoPath(projection, ctx)(cell.geometry);
      return { d: ctx.toPath(), fill: cellColor(cell, mode), stroke: "#0003", strokeWidth: 0.25 };
    });
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
            cell {tooltip.cell.id} · value {tooltip.cell.value.toFixed(3)} · bioregion{" "}
            {tooltip.cell.bioregion}
          </div>
        )}
      </div>
    </div>
  );
}

function download(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
}
