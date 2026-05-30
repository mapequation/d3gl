/** One styled path in an SVG document. */
export interface SvgPath {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

/**
 * Assemble styled paths into a standalone SVG document string. Paths with an
 * empty `d` are skipped. `fill` defaults to "none" when only a stroke is given,
 * otherwise to the provided fill.
 */
export function svgDocument(width: number, height: number, paths: readonly SvgPath[]): string {
  const body = paths
    .filter((p) => p.d.length > 0)
    .map((p) => {
      const fill = p.fill ?? (p.stroke ? "none" : "#000");
      const attrs = [`d="${p.d}"`, `fill="${fill}"`];
      if (p.stroke) attrs.push(`stroke="${p.stroke}"`);
      if (p.strokeWidth != null) attrs.push(`stroke-width="${p.strokeWidth}"`);
      return `  <path ${attrs.join(" ")} />`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${body}\n</svg>`;
}
