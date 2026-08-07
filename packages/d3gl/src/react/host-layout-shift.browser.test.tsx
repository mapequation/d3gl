import { describe, it, expect } from "vitest";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { geoEquirectangular } from "d3-geo";
import { GeoMap } from "./GeoMap.js";
import type { GeoMap as Engine } from "../map/index.js";

/**
 * #39 / #273 — the React consumer's half of `map/auto-layout-shift.browser.test.ts`.
 *
 * `<GeoMap>` renders `<div style={{ position: "relative", ...hostSizeStyle(...) }}>`, so the box
 * is reserved by React's FIRST commit, before any engine (and therefore any backend canvas)
 * exists. The case pinned here is the one #39 was written for: `StrictMode` + `backend: "auto"`,
 * where the double-mount and the canvas→WebGL upgrade can leave three or four surfaces in the
 * host at once. In flow those would stack and flush later content down by 3-4 × the map height;
 * out of flow (`makeCanvas` sets `position:absolute`) they overlap and layout never notices.
 *
 * One engine only — a real WebGL device costs a browser GL context, and the shared browser suite
 * starves when one file holds several.
 */

const W = 400;
const H = 300;

const nextFrame = (): Promise<void> => new Promise((res) => requestAnimationFrame(() => res()));

async function waitUntil(pred: () => boolean, budgetMs = 5000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    if (pred()) return true;
    await nextFrame();
  }
  return pred();
}

/** A WebGL-backed surface yields a webgl2 context; the Canvas2D placeholder does not. */
const isWebGL = (mount: HTMLElement): boolean => {
  const c = mount.querySelector("canvas");
  if (!c) return false;
  try {
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
};

describe("<GeoMap> host box and layout shift (#39 / #273)", () => {
  it('StrictMode + backend "auto": the following sibling never moves after the first commit', async () => {
    const page = document.createElement("div");
    page.style.position = "relative";
    page.style.width = "600px";
    const before = document.createElement("div");
    before.style.height = "20px";
    const mount = document.createElement("div");
    const after = document.createElement("div");
    after.style.height = "20px";
    page.append(before, mount, after);
    document.body.appendChild(page);

    const top = (): number => after.getBoundingClientRect().top - page.getBoundingClientRect().top;
    const hostH = (): number => mount.getBoundingClientRect().height;
    expect(hostH()).toBe(0); // nothing rendered yet

    const root = createRoot(mount);
    const ready = new Promise<Engine>((resolve) => {
      root.render(
        <StrictMode>
          <GeoMap
            width={W}
            height={H}
            projection={geoEquirectangular().scale(50).translate([W / 2, H / 2])}
            backend="auto"
            onReady={(m) => resolve(m)}
          />
        </StrictMode>,
      );
    });

    // createRoot().render() commits asynchronously; the box appears with the host <div>.
    expect(await waitUntil(() => mount.firstElementChild !== null)).toBe(true);
    expect(hostH()).toBe(H);
    const base = top();

    await ready;
    expect(top()).toBe(base);
    expect(hostH()).toBe(H);

    expect(await waitUntil(() => isWebGL(mount))).toBe(true); // the auto upgrade landed
    expect(top()).toBe(base);
    expect(hostH()).toBe(H);

    await nextFrame();
    await nextFrame();
    expect(top()).toBe(base);

    // Every surface the host holds is out of flow, which is why none of the above could move.
    const canvases = [...mount.querySelectorAll("canvas")];
    expect(canvases.length).toBeGreaterThan(0);
    for (const c of canvases) {
      expect(getComputedStyle(c).position).toBe("absolute");
      c.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    }

    root.unmount();
    page.remove();
  });
});
