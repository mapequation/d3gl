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
