import { rgb } from "d3-color";
import type { InstancedCirclesData } from "../core/index.js";
import type { InteractiveLayerOptions } from "./base-engine.js";

/**
 * Selection/hover ring overlay for instanced-lane glyphs (#105 N7c-2) — shared by network nodes and
 * plot declutter points. A ring is a transparent-fill circle whose border occupies the outer band,
 * sized as a multiple of the glyph radius so it hugs the glyph identically at any zoom and in either
 * sizeMode (world/screen) — both ratios are dimensionless, so no unit conversion is needed.
 */
export type RGBA = [number, number, number, number];
const RING_OUTER = 1.34; // ring outer radius ÷ glyph radius
const RING_BORDER_FRAC = 0.16; // border thickness ÷ ring outer radius
const DEFAULT_SELECT_RING: RGBA = [255, 106, 0, 255]; // orange — the persistent selection ring
const DEFAULT_HOVER_RING: RGBA = [255, 255, 255, 255]; // white — the transient hover ring

function cssToRgba(css: string, fallback: RGBA): RGBA {
  const c = rgb(css);
  if (Number.isNaN(c.r)) return fallback;
  return [Math.round(c.r) & 255, Math.round(c.g) & 255, Math.round(c.b) & 255, Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255) & 255];
}

/** Resolve the select/hover ring colours from the interaction opts (`selection.selected.stroke` / a
 *  hover {@link HighlightStyle}'s `stroke`), falling back to the orange/white defaults. */
export function resolveRingColors(opts: InteractiveLayerOptions): { select: RGBA; hover: RGBA } {
  const selStroke = opts.selection?.selected?.stroke;
  const hov = opts.hover;
  const hovStroke = hov && typeof hov === "object" && "stroke" in hov ? (hov as { stroke?: string }).stroke : undefined;
  return {
    select: selStroke ? cssToRgba(selStroke, DEFAULT_SELECT_RING) : DEFAULT_SELECT_RING,
    hover: hovStroke ? cssToRgba(hovStroke, DEFAULT_HOVER_RING) : DEFAULT_HOVER_RING,
  };
}

/**
 * Build one ring circle per highlighted glyph (transparent fill + coloured border). `centerOf`/
 * `radiusOf` read the glyph's world/screen centre + radius for a source id; `isSelected` picks the
 * persistent select colour over the transient hover colour for ids in the selection set.
 */
export function ringCircles(
  ids: Uint32Array,
  centerOf: (g: number) => [number, number],
  radiusOf: (g: number) => number,
  isSelected: (g: number) => boolean,
  colors: { select: RGBA; hover: RGBA },
): InstancedCirclesData {
  const count = ids.length;
  const centers = new Float32Array(count * 2);
  const radii = new Float32Array(count);
  const borders = new Float32Array(count);
  const borderColors = new Uint8Array(count * 4);
  for (let k = 0; k < count; k++) {
    const g = ids[k]!;
    const [cx, cy] = centerOf(g);
    centers[k * 2] = cx;
    centers[k * 2 + 1] = cy;
    radii[k] = radiusOf(g) * RING_OUTER;
    borders[k] = RING_BORDER_FRAC;
    const col = isSelected(g) ? colors.select : colors.hover;
    borderColors[k * 4] = col[0];
    borderColors[k * 4 + 1] = col[1];
    borderColors[k * 4 + 2] = col[2];
    borderColors[k * 4 + 3] = col[3];
  }
  return { centers, radii, colors: new Uint8Array(count * 4), borders, borderColors, count };
}
