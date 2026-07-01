import { rgb } from "d3-color";
import type { InstancedCirclesData } from "../core/index.js";
import type { InteractiveLayerOptions } from "./base-engine.js";
import { hoverParts } from "./highlight.js";

/**
 * Selection/hover ring overlay for instanced-lane glyphs (#105 N7c-2) — shared by network nodes and
 * plot declutter points. A ring is a transparent-fill circle whose border occupies the outer band,
 * sized as a multiple of the glyph radius so it hugs the glyph identically at any zoom and in either
 * sizeMode (world/screen) — both ratios are dimensionless, so no unit conversion is needed.
 */
export type RGBA = [number, number, number, number];
const RING_OUTER = 1.34; // ring outer radius ÷ glyph radius
const RING_BORDER_FRAC = 0.16; // border thickness ÷ ring outer radius
// Default highlight palette (#162): red = selected AND hover (one focus colour, matched by the shader
// link recolour), yellow = "will remove" (subtract-marquee preview). The marquee +/- badges are neutral gray.
const DEFAULT_SELECT_RING: RGBA = [220, 38, 38, 255]; // red (#dc2626) — the persistent selection ring
const DEFAULT_HOVER_RING: RGBA = [220, 38, 38, 255]; // red (#dc2626) — the transient hover ring (same red as selected)
const DEFAULT_REMOVE_RING: RGBA = [234, 179, 8, 255]; // yellow (#eab308) — "will be removed" (subtract-marquee preview)

function cssToRgba(css: string, fallback: RGBA): RGBA {
  const c = rgb(css);
  if (Number.isNaN(c.r)) return fallback;
  return [Math.round(c.r) & 255, Math.round(c.g) & 255, Math.round(c.b) & 255, Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255) & 255];
}

/** Resolve the select/hover ring colours from the interaction opts (`selection.selected.stroke` / a
 *  hover {@link HighlightStyle}'s `stroke`), falling back to the blue (select) / green (hover) defaults. */
export function resolveRingColors(opts: InteractiveLayerOptions): { select: RGBA; hover: RGBA; remove: RGBA } {
  const selStroke = opts.selection?.selected?.stroke;
  // The hover ring's stroke comes from the hovered-item style (`hover.hovered.stroke`, or a bare
  // HighlightStyle's `stroke` in the back-compat flat form) — see hoverParts (#162).
  const hovered = hoverParts(opts.hover).hovered;
  const hovStroke = hovered && typeof hovered === "object" && "stroke" in hovered ? hovered.stroke : undefined;
  return {
    select: selStroke ? cssToRgba(selStroke, DEFAULT_SELECT_RING) : DEFAULT_SELECT_RING,
    hover: hovStroke ? cssToRgba(hovStroke, DEFAULT_HOVER_RING) : DEFAULT_HOVER_RING,
    remove: DEFAULT_REMOVE_RING,
  };
}

/**
 * Build one ring circle per highlighted glyph (transparent fill + coloured border). `centerOf`/
 * `radiusOf` read the glyph's world/screen centre + radius for a source id; `isSelected` picks the
 * persistent select colour over the transient hover colour for ids in the selection set. `isRemove`
 * (optional) overrides both with the `remove` colour for glyphs a subtract-marquee will deselect
 * (#140) — red "will be removed", the inverse of the blue "will be added" hover preview.
 */
export function ringCircles(
  ids: Uint32Array,
  centerOf: (g: number) => [number, number],
  radiusOf: (g: number) => number,
  isSelected: (g: number) => boolean,
  colors: { select: RGBA; hover: RGBA; remove?: RGBA },
  isRemove?: (g: number) => boolean,
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
    const col = isRemove?.(g) && colors.remove ? colors.remove : isSelected(g) ? colors.select : colors.hover;
    borderColors[k * 4] = col[0];
    borderColors[k * 4 + 1] = col[1];
    borderColors[k * 4 + 2] = col[2];
    borderColors[k * 4 + 3] = col[3];
  }
  return { centers, radii, colors: new Uint8Array(count * 4), borders, borderColors, count };
}
