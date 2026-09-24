/**
 * The **force-pan modifier** (#178): hold it while dragging and the drag always pans, never grabs a
 * draggable glyph, whatever is under the cursor. On a dense network nearly every press lands on a
 * node, so this is how you can still navigate one without turning node-drag off.
 *
 * It is the platform's command key: ⌘ (`metaKey`) on Apple platforms and Ctrl (`ctrlKey`) everywhere
 * else. Ctrl can't be the key on a Mac, because ctrl-click opens the context menu there (which is why
 * d3-zoom refuses a Ctrl-drag by default).
 */
export type PanModifier = "metaKey" | "ctrlKey";

/** The force-pan modifier for a platform string (`navigator.platform`, or a user agent as fallback). */
export function panModifierFor(platform: string): PanModifier {
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "metaKey" : "ctrlKey";
}

/** The navigator fields detection reads — a structural subset, so a test can pass a plain object. */
export interface PlatformInfo {
  readonly platform?: string;
  readonly userAgent?: string;
}

/** The force-pan modifier for a navigator: `platform`, falling back to `userAgent` when it is empty.
 *  Without a navigator (SSR) it is Ctrl. */
export function detectPanModifier(nav: PlatformInfo | undefined): PanModifier {
  return nav ? panModifierFor(nav.platform || nav.userAgent || "") : "ctrlKey";
}

/** This platform's force-pan modifier, detected once at load. */
export const PAN_MODIFIER: PanModifier = detectPanModifier(typeof navigator === "undefined" ? undefined : navigator);
