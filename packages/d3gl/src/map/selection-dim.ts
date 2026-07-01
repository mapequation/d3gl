/**
 * Selection "others" dimming for instanced lanes (#162) — the lane analogue of a Scene layer's
 * `selection.others`. Scene layers dim their non-selected drawables by rewriting the style-override
 * map (`BaseEngine._applySelect`); instanced glyphs (network nodes, plot points, network links) have
 * no Scene drawable to recolor, so the same effect is a **per-instance alpha multiply** applied in the
 * lane's emit body — reusing the cross-fade alpha pattern (#133). Both network and plot import this so
 * `selection.others` behaves identically across geoMap / plot / network.
 *
 * Lanes honor only the **opacity** component of `others` (the alpha multiply); a colour override on a
 * lane's `others` is not applied (it would need per-instance recolour, out of scope) — documented on
 * the option. The default, matching Scene, is `{ opacity: 0.3 }` (see {@link BaseEngine.othersDim}).
 */
import { hcl, rgb } from "d3-color";

/**
 * Multiply the alpha byte of every **non-kept** instance's RGBA in `colors` by `opacity`, in place.
 * `isKept(k)` marks the instances that stay full strength (the selected glyphs and, for network links,
 * a selected node's outgoing edges). No-op when `colors` is absent or `opacity >= 1`.
 *
 * Cost: one O(`count`) pass. Callers gate it to run only when a selection is active (opacity comes
 * from {@link BaseEngine.othersDim}, which returns null with no selection), so unselected frames pay
 * nothing. Composes multiplicatively with any prior alpha scale (e.g. the LOD cross-fade), since it
 * scales the already-written alpha byte rather than replacing it.
 */
export function dimOthers(
  colors: Uint8Array | undefined,
  count: number,
  opacity: number,
  isKept: (k: number) => boolean,
): void {
  if (!colors || opacity >= 1) return;
  for (let k = 0; k < count; k++) {
    if (!isKept(k)) colors[k * 4 + 3] = Math.round(colors[k * 4 + 3]! * opacity);
  }
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Recolor every instance for which `isMatch(k)` is true toward HCL hue `hue` (degrees), preserving each
 * instance's **lightness and alpha** (#162). Used to highlight a hovered network node's *existing* links
 * (correct bend / half-arrow / width / direction — nothing re-built) in the hover colour while keeping
 * their weight cue: a heavy link is encoded darker + more opaque, and HCL lightness ≈ perceptual
 * darkness, so the weight reads through the hue change. `minChroma` floors the chroma so a near-gray
 * input still becomes visibly that hue. O(`count`) over the instances scanned; only the RGB bytes change.
 */
export function hueShiftToward(
  colors: Uint8Array | undefined,
  count: number,
  isMatch: (k: number) => boolean,
  hue: number,
  minChroma: number,
): void {
  if (!colors) return;
  for (let k = 0; k < count; k++) {
    if (!isMatch(k)) continue;
    const i = k * 4;
    const c = hcl(rgb(colors[i]!, colors[i + 1]!, colors[i + 2]!));
    const l = Number.isNaN(c.l) ? 0 : c.l;
    const chroma = Math.max(Number.isNaN(c.c) ? 0 : c.c, minChroma);
    const out = hcl(hue, chroma, l).rgb();
    colors[i] = clamp255(out.r);
    colors[i + 1] = clamp255(out.g);
    colors[i + 2] = clamp255(out.b);
  }
}
