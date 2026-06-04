// website/src/components/controls.ts
//
// The control bar is now rendered server-side in ExampleFrame.astro with
// Starwind components (Button / ButtonGroup / Slider / Separator) and wired
// imperatively in example-runtime.ts. The old JS element builders (segmented,
// slider, actionButton) are gone; this module keeps the small, testable
// helpers that the runtime wiring relies on.

import { button } from "./starwind/button/variants.ts";

// Every segmented option renders with the Starwind `outline` button variant so
// the ButtonGroup joins them into one seamless control (shared borders, equal
// height, no detached/floating button). The active option layers the red
// `primary` tokens on top — a scoped active-state exception, since Starwind has
// no dedicated segmented-toggle primitive. These two class strings are the
// single source of truth shared by ExampleFrame.astro and the runtime.
export const SEGMENT_BASE = button({ variant: "outline", size: "sm" });
// Active: red fill + white text, overriding the outline variant's surface/hover.
export const SEGMENT_ACTIVE_OVERRIDE =
  "bg-primary! text-primary-foreground! border-primary! hover:bg-primary! shadow-none";
export const INACTIVE_CLASS = SEGMENT_BASE;
export const ACTIVE_CLASS = `${SEGMENT_BASE} ${SEGMENT_ACTIVE_OVERRIDE}`;

/**
 * Toggle the active option inside a segmented ButtonGroup: marks the chosen
 * button with `data-active` and swaps each button's class to the active/inactive
 * style. Operates on `[data-backend]` and `[data-control-value]` items.
 */
export function setActive(group: HTMLElement, chosen: HTMLElement): void {
  group.querySelectorAll<HTMLElement>("[data-backend], [data-control-value]").forEach((btn) => {
    const active = btn === chosen;
    btn.toggleAttribute("data-active", active);
    btn.className = active ? ACTIVE_CLASS : INACTIVE_CLASS;
  });
}

/**
 * Format a slider value for its label, using optional per-step display labels
 * indexed by (value - min) / step (e.g. ["1°","2°","4°","8°"]).
 */
export function formatRange(
  value: number,
  spec: { min: number; step: number; display?: string[] },
): string {
  return spec.display?.[(value - spec.min) / spec.step] ?? String(value);
}

/** Trigger a browser download of a data URL or string payload. */
export function download(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
}
