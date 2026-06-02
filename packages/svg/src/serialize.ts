import type { RenderLayer, ViewTransform, DrawableVector } from "@d3gl/core";
import { SvgPathContext } from "./svg-context.js";

function rgba([r, g, b, a]: readonly [number, number, number, number]): string {
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(4)})`;
}

function pathD(d: DrawableVector): string {
  const ctx = new SvgPathContext();
  for (const s of d.subpaths) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    if (s.closed) ctx.closePath();
  }
  return ctx.toPath();
}

/** Path d-string for an anchored glyph at a constant pixel size: each vertex offset from
 *  the anchor is kept as-is around the anchor's projected screen position (ox, oy). */
function pathDScreen(d: DrawableVector, ax: number, ay: number, ox: number, oy: number): string {
  const ctx = new SvgPathContext();
  for (const s of d.subpaths) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.moveTo(ox + (p[0]! - ax), oy + (p[1]! - ay));
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(ox + (p[i]! - ax), oy + (p[i + 1]! - ay));
    if (s.closed) ctx.closePath();
  }
  return ctx.toPath();
}

/** Render one drawable's fill/stroke attributes as a string of SVG elements. */
function drawableElements(d: DrawableVector): string {
  const fill = d.fill[3] > 0 ? rgba(d.fill) : "none";
  const strokeAttrs =
    d.stroke[3] > 0 && d.lineWidth > 0
      ? ` stroke="${rgba(d.stroke)}" stroke-width="${d.lineWidth}"`
      : "";
  if (d.circles.length > 0) {
    // Circle drawable: emit a <circle> per center.
    return d.circles
      .map((c) => `<circle cx="${c.x}" cy="${c.y}" r="${c.r}" fill="${fill}"${strokeAttrs} />`)
      .join("");
  }
  // Path drawable.
  return `<path d="${pathD(d)}" fill="${fill}"${strokeAttrs} />`;
}

/** A full SVG document for the given layers under a view transform. */
export function svgFromLayers(width: number, height: number, layers: readonly RenderLayer[], t: ViewTransform): string {
  const defs: string[] = [];
  const groups: string[] = [];
  // Screen-mode point drawables are emitted in a separate untransformed group on top.
  const screenCircleGroups: string[] = [];

  for (const layer of layers) {
    const screenMode = layer.sizeMode === "screen";

    // A clipPath def referencing the named clip layer's silhouette.
    let clipAttr = "";
    if (layer.clipTo) {
      const src = layers.find((l) => l.name === layer.clipTo);
      if (src) {
        const id = `clip-${layer.name}`;
        const shapes = src.drawables
          .filter((d) => (d.flags & 1) !== 0)
          .map((d) => {
            if (d.circles.length > 0) {
              return d.circles.map((c) => `<circle cx="${c.x}" cy="${c.y}" r="${c.r}" />`).join("");
            }
            return `<path d="${pathD(d)}" />`;
          })
          .join("");
        defs.push(`<clipPath id="${id}">${shapes}</clipPath>`);
        clipAttr = ` clip-path="url(#${id})"`;
      }
    }

    if (screenMode) {
      // Screen sizeMode: circles and anchored glyphs render at constant pixel size in an
      // untransformed group; non-anchored paths stay in the transformed group but with a
      // constant pixel stroke width (divide by k, which the group's scale(k) re-multiplies).
      const screenEls: string[] = [];
      const worldEls: string[] = [];
      for (const d of layer.drawables) {
        if ((d.flags & 1) === 0) continue;
        const fill = d.fill[3] > 0 ? rgba(d.fill) : "none";
        const hasStroke = d.stroke[3] > 0 && d.lineWidth > 0;
        if (d.circles.length > 0) {
          const sa = hasStroke ? ` stroke="${rgba(d.stroke)}" stroke-width="${d.lineWidth}"` : "";
          screenEls.push(d.circles.map((c) => `<circle cx="${t.k * c.x + t.x}" cy="${t.k * c.y + t.y}" r="${c.r}" fill="${fill}"${sa} />`).join(""));
        } else if (d.anchor) {
          const [ax, ay] = d.anchor;
          const sa = hasStroke ? ` stroke="${rgba(d.stroke)}" stroke-width="${d.lineWidth}"` : "";
          screenEls.push(`<path d="${pathDScreen(d, ax, ay, t.k * ax + t.x, t.k * ay + t.y)}" fill="${fill}"${sa} />`);
        } else {
          const sa = hasStroke ? ` stroke="${rgba(d.stroke)}" stroke-width="${d.lineWidth / t.k}"` : "";
          worldEls.push(`<path d="${pathD(d)}" fill="${fill}"${sa} />`);
        }
      }
      if (worldEls.length) groups.push(`<g${clipAttr}>${worldEls.join("")}</g>`);
      if (screenEls.length) screenCircleGroups.push(`<g>${screenEls.join("")}</g>`);
    } else {
      const elements = layer.drawables
        .filter((d) => (d.flags & 1) !== 0)
        .map(drawableElements)
        .join("");
      groups.push(`<g${clipAttr}>${elements}</g>`);
    }
  }
  const transform = `translate(${t.x}, ${t.y}) scale(${t.k})`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${defs.join("")}</defs><g transform="${transform}">${groups.join("")}</g>` +
    (screenCircleGroups.length > 0 ? screenCircleGroups.join("") : "") +
    `</svg>`
  );
}
