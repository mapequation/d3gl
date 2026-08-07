import { describe, it, expect, afterAll } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { GeoMap } from "./geo-map.js";
import type { BackendType } from "./backend-factory.js";

/**
 * #39 / #273 — engine construction must not cause a LAYOUT SHIFT.
 *
 * The remembered symptom behind `backend: "auto"` was that a `"webgl"` map only put its
 * `<canvas>` in the document once the device resolved (100s of ms), so later page content was
 * flushed down when it arrived. #39 made every backend canvas `position:absolute` inside a
 * positioned host, which takes it **out of flow**: it cannot contribute to the host's height at
 * any time, on any backend. The box therefore comes from the consumer's CSS (or, in
 * `aspectRatio` mode, from the CSS `resolveSizing` writes synchronously in the constructor), and
 * nothing the async backend does afterwards can move anything.
 *
 * These legs measure that rather than asserting it from the source: they record the HOST box and
 * the top of a SIBLING placed AFTER the host in normal flow — which is what "content flushed
 * down" actually means — before construction, synchronously after it, after `whenReady()` and
 * after the backend has fully settled (including `"auto"`'s WebGL upgrade).
 *
 * Deliberately small: each real-WebGL engine costs a browser GL context, and the shared browser
 * suite starves if a single file holds many. The full backend × sizing-mode matrix was measured
 * once and recorded on #273; what is pinned here is one leg per distinct mechanism.
 */

/** Test seam: `whenBackendSettled()` is protected — unlike `whenReady()` it also awaits the
 *  `"auto"` → WebGL upgrade, which is exactly the window a late layout shift would live in. */
class SettleableGeoMap extends GeoMap {
  settled(): Promise<void> {
    return this.whenBackendSettled();
  }
}

const W = 400;
const H = 300;
const PAGE_WIDTH = 600;
const BEFORE_H = 20;

interface Sample {
  phase: string;
  /** Host box height in CSS px. */
  hostH: number;
  /** Top of the after-host sibling, relative to the page wrapper (CSS px). */
  siblingTop: number;
  /** The same distance via the offsetTop chain. */
  siblingOffsetTop: number;
}

const rows: { label: string; samples: Sample[] }[] = [];

interface Page {
  page: HTMLDivElement;
  host: HTMLDivElement;
  after: HTMLDivElement;
  remove(): void;
}

/** A page fragment in normal flow: [before][host][after]. `page` is positioned so the sibling's
 *  offsetTop is measured against it, not against a test-run-dependent body. */
function makePage(): Page {
  const page = document.createElement("div");
  page.style.position = "relative";
  page.style.width = `${PAGE_WIDTH}px`;
  const before = document.createElement("div");
  before.style.height = `${BEFORE_H}px`;
  const host = document.createElement("div");
  const after = document.createElement("div");
  after.style.height = "20px";
  page.append(before, host, after);
  document.body.appendChild(page);
  return { page, host, after, remove: () => page.remove() };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

function sample(p: Page, phase: string): Sample {
  const pageTop = p.page.getBoundingClientRect().top;
  return {
    phase,
    hostH: r2(p.host.getBoundingClientRect().height),
    siblingTop: r2(p.after.getBoundingClientRect().top - pageTop),
    siblingOffsetTop: p.after.offsetTop,
  };
}

/**
 * Drop each backend canvas's WebGL2 context explicitly. Chromium caps live contexts per process
 * and `destroy()` does not free them promptly (luma never calls `WEBGL_lose_context`), which
 * starves other files sharing the browser. Call while the canvases are still in the host.
 */
function releaseGL(host: HTMLElement): void {
  for (const c of host.querySelectorAll("canvas")) {
    c.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

const proj = (): ReturnType<typeof geoEquirectangular> => geoEquirectangular().scale(50).translate([W / 2, H / 2]);
const sqPoly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

/** What a run observed. Computed styles are read while the nodes are still attached — a detached
 *  element reports empty strings — so the caller can assert them after teardown. */
interface Run {
  samples: Sample[];
  /** `getComputedStyle(host).position` at settle. */
  hostPosition: string;
  /** `getComputedStyle(canvas).position` for every backend surface the host held at settle. */
  surfacePositions: string[];
}

/**
 * Build an engine in a fresh page fragment, sample the four lifecycle phases, then tear
 * everything down. `styleHost` is the CSS a consumer would set (what the React wrappers'
 * `hostSizeStyle` emits).
 */
async function measure(
  label: string,
  backend: BackendType,
  opts: { width?: number; height?: number; aspectRatio?: number },
  styleHost?: (h: HTMLElement) => void,
): Promise<Run> {
  const p = makePage();
  styleHost?.(p.host);
  const samples: Sample[] = [sample(p, "1-before-construct")];
  const map = new SettleableGeoMap(p.host, { ...opts, projection: proj(), backend });
  samples.push(sample(p, "2-sync-after-construct"));
  map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(255,0,0)", id: () => "c0" });
  await map.whenReady();
  samples.push(sample(p, "3-after-whenReady"));
  await map.settled();
  samples.push(sample(p, "4-after-settled"));
  rows.push({ label, samples });
  const hostPosition = getComputedStyle(p.host).position;
  const surfacePositions = [...p.host.querySelectorAll("canvas")].map((c) => getComputedStyle(c).position);
  releaseGL(p.host);
  map.destroy();
  p.remove();
  return { samples, hostPosition, surfacePositions };
}

/** Every phase from `2-sync-after-construct` onward must report the same sibling position. */
function expectStableAfterConstruct(samples: Sample[]): void {
  const base = samples[1];
  expect(base).toBeDefined();
  for (const s of samples.slice(1)) {
    expect(s.siblingTop, `${s.phase} moved the sibling`).toBe(base?.siblingTop);
    expect(s.hostH, `${s.phase} changed the host height`).toBe(base?.hostH);
  }
}

describe("engine construction and layout shift (#39 / #273)", () => {
  it("CONTROL: an IN-FLOW backend canvas would shift the sibling — this is the pre-#39 mechanism", () => {
    const p = makePage();
    p.host.style.width = `${W}px`;
    const base = sample(p, "empty-host").siblingTop;

    const mk = (): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.style.display = "block";
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
      p.host.appendChild(c);
      return c;
    };
    const a = mk();
    const one = sample(p, "one-in-flow-canvas").siblingTop;
    const b = mk();
    const two = sample(p, "two-in-flow-canvases").siblingTop;

    // A canvas that enters the flow late pushes later content down by its full height…
    expect(one - base).toBe(H);
    // …and two coexisting ones (the "auto" upgrade window, doubled again under StrictMode) by 2×.
    expect(two - base).toBe(2 * H);

    // Exactly what `makeCanvas` does removes both effects.
    for (const c of [a, b]) {
      c.style.position = "absolute";
      c.style.top = "0";
      c.style.left = "0";
    }
    expect(sample(p, "both-absolute").siblingTop - base).toBe(0);

    rows.push({
      label: 'CONTROL: in-flow canvases (pre-#39), no engine',
      samples: [
        { phase: "empty host", hostH: 0, siblingTop: base, siblingOffsetTop: base },
        { phase: "1 in-flow canvas", hostH: H, siblingTop: one, siblingOffsetTop: one },
        { phase: "2 in-flow canvases", hostH: 2 * H, siblingTop: two, siblingOffsetTop: two },
        { phase: "both absolute", hostH: 0, siblingTop: base, siblingOffsetTop: base },
      ],
    });
    p.remove();
  });

  it('backend "webgl", fixed size, host sized by the consumer: nothing moves while the device is created', async () => {
    const { samples } = await measure(
      'webgl / fixed, host sized by consumer',
      "webgl",
      { width: W, height: H },
      (h) => {
        h.style.width = `${W}px`;
        h.style.height = `${H}px`;
      },
    );
    // The box exists before the engine does, and the async device never changes it.
    expect(samples[0]?.hostH).toBe(H);
    expectStableAfterConstruct(samples);
  });

  // Backend-independent by construction: the box comes from CSS `resolveSizing` writes in the
  // constructor, before any backend exists. Run on "canvas" so this file holds only two live GL
  // contexts (the shared browser suite starves otherwise); the `"webgl"` and `"auto"` rows were
  // measured identical and are recorded on #273.
  it('aspectRatio: the only shift is paid synchronously by the constructor', async () => {
    const { samples } = await measure('canvas / aspectRatio', "canvas", { aspectRatio: W / H });
    // `resolveSizing` writes width:100% + aspect-ratio on the host, so the box appears during
    // the constructor — before any backend exists — and then never changes.
    expect(samples[0]?.hostH).toBe(0);
    expect(samples[1]?.hostH).toBeGreaterThan(0);
    expectStableAfterConstruct(samples);
  });

  it('backend "auto", fill-parent: the canvas→WebGL swap is invisible to layout', async () => {
    const run = await measure('auto / fill-parent', "auto", {}, (h) => {
      h.style.width = "100%";
      h.style.height = `${H}px`;
    });
    expect(run.samples[0]?.hostH).toBe(H);
    expectStableAfterConstruct(run.samples);
    // The mechanism, pinned: the host is positioned and every surface it held is out of flow.
    expect(run.hostPosition).toBe("relative");
    expect(run.surfacePositions.length).toBeGreaterThan(0);
    for (const pos of run.surfacePositions) expect(pos).toBe("absolute");
  });

  it('backend "canvas", bare host: an unstyled host collapses — stably, with no shift', async () => {
    // Documented, not a bug in disguise: in fixed mode the engine leaves host CSS untouched, and
    // the canvas is out of flow, so a consumer who supplies no CSS gets a zero-height host on
    // EVERY backend. That overlaps later content from the first frame; it never moves it.
    const { samples } = await measure('canvas / fixed, bare host', "canvas", { width: W, height: H });
    for (const s of samples) expect(s.hostH).toBe(0);
    expectStableAfterConstruct(samples);
  });

  afterAll(() => {
    const lines = ["", "=== #273 host-box / sibling-offset measurements (CSS px) ===", ""];
    for (const row of rows) {
      lines.push(`--- ${row.label}`);
      lines.push("    phase                     hostH   siblingTop   siblingOffsetTop");
      for (const s of row.samples) {
        lines.push(
          `    ${s.phase.padEnd(24)}  ${String(s.hostH).padStart(5)}   ${String(s.siblingTop).padStart(10)}   ${String(s.siblingOffsetTop).padStart(16)}`,
        );
      }
      lines.push("");
    }
    console.log(lines.join("\n"));
  });
});
