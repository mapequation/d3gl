import type { Network } from "../network.js";
import type { HoverHit } from "../../map/base-engine.js";
import type { ViewTransform } from "../../core/index.js";

/**
 * Where a drag guard grabs an open module by its boundary ring, and the same module collapsed (#479), found
 * through `pick` — the pick the pointer-down grab runs — so a guard never reads the engine's private ring batch.
 */

/** Whether a hit is an open module picked by its boundary ring (`datum.open`, #476). */
export function isOpenHit(hit: HoverHit | null): boolean {
  const d = hit?.datum;
  return typeof d === "object" && d !== null && "open" in d && d.open === true;
}

/** What a guard needs for one grab: the view, the screen point, and a leaf under the grabbed target. */
export interface Grab {
  view: ViewTransform;
  x: number;
  y: number;
  /** A leaf the grab holds: the guard checks it stays under the cursor. */
  ref: number;
}

/** The view of world point (cx, cy) at the centre of a `w` × `h` host, at zoom `k`. */
export const centredOn = (cx: number, cy: number, k: number, w: number, h: number): ViewTransform => ({ k, x: w / 2 - cx * k, y: h / 2 - cy * k });

/**
 * The first ring the drawn view shows on the host's centre lines, scanning outward from the centre (the
 * horizontal line, then the vertical one): the point and its hit. With `g`, only module `g`'s ring.
 */
export function ringOnCentreLines(net: Network, w: number, h: number, g?: number): { x: number; y: number; hit: HoverHit } | null {
  const at = (x: number, y: number): { x: number; y: number; hit: HoverHit } | null => {
    const hit = net.pick(x, y);
    return hit && isOpenHit(hit) && (g === undefined || hit.id === g) ? { x, y, hit } : null;
  };
  for (let d = 0; d < w / 2; d++) {
    const found = at(w / 2 + d, h / 2) ?? at(w / 2 - d, h / 2);
    if (found) return found;
  }
  for (let d = 0; d < h / 2; d++) {
    const found = at(w / 2, h / 2 + d) ?? at(w / 2, h / 2 - d);
    if (found) return found;
  }
  return null;
}

/**
 * Module `g` collapsed: zooming out from `k` by 1.5× a step, centred on (cx, cy) (its leaves' centroid), the
 * first view whose pick finds `g` as a glyph — not its ring — near the centre. `show` draws a view.
 */
export function collapsedGlyph(net: Network, w: number, h: number, g: number, cx: number, cy: number, k: number, show: (view: ViewTransform) => void): { view: ViewTransform; x: number; y: number } | null {
  for (let step = 1; step <= 24; step++) {
    const view = centredOn(cx, cy, k / 1.5 ** step, w, h);
    show(view);
    for (let r = 0; r <= 16; r += 2) {
      for (let i = -r; i <= r; i += 2) {
        for (const [x, y] of [[w / 2 + i, h / 2 - r], [w / 2 + i, h / 2 + r], [w / 2 - r, h / 2 + i], [w / 2 + r, h / 2 + i]] as const) {
          const hit = net.pick(x, y);
          if (hit?.id === g && !isOpenHit(hit)) return { view, x, y };
        }
      }
    }
  }
  return null;
}
