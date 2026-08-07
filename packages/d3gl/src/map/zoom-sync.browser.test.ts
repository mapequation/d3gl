import { describe, it, expect } from "vitest";
import { zoomTransform } from "d3-zoom";
import { plot } from "./plot.js";

/**
 * Programmatic `setTransform` must carry d3-zoom's internal transform with it (#202).
 *
 * `enableZoom` seeds d3-zoom once, at call time. Any programmatic view change made afterwards —
 * a fit, a zoom-to-module, a centering translate — used to leave that seed stale, so the next
 * wheel/drag measured its delta from the OLD view and the camera visibly snapped back before
 * zooming. The user report was "it jumps in when I start to zoom so I have to zoom out a while to
 * get to initial view", and the consumer workaround was to re-call `enableZoom()` after every
 * programmatic fit.
 *
 * The assertion here is the deterministic signature, not a simulated gesture: d3-zoom stores its
 * transform on the DOM node, so `zoomTransform(node)` IS the state the next gesture will start
 * from. If it tracks the engine, no gesture can jump.
 */
function host(w = 240, h = 180): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  document.body.appendChild(el);
  return el;
}

/** d3-zoom's own view of the gesture base — what a wheel/drag delta is applied to. */
function gestureTransform(el: HTMLElement): { k: number; x: number; y: number } {
  const t = zoomTransform(el);
  return { k: t.k, x: t.x, y: t.y };
}

describe("programmatic setTransform keeps the zoom gesture in step (#202)", () => {
  it("d3-zoom's stored transform tracks a programmatic setTransform made AFTER enableZoom", async () => {
    const el = host();
    const chart = plot(el, { width: 240, height: 180, backend: "webgl" });
    await chart.whenReady();
    chart.points("pts", [{ x: 0, y: 0 }, { x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 4, fill: "#333" });
    chart.enableZoom([0.5, 40]);

    // Seeded from the engine's view at enableZoom() time.
    expect(gestureTransform(el)).toEqual({ k: 1, x: 0, y: 0 });

    // A programmatic fit, exactly as a consumer's fit-to-data or zoom-to-region would do.
    chart.setTransform({ k: 4, x: -120, y: -60 });
    expect(gestureTransform(el), "gesture base went stale after a programmatic setTransform").toEqual({ k: 4, x: -120, y: -60 });

    // And it keeps tracking across further programmatic changes.
    chart.setTransform({ k: 2.5, x: -30, y: -15 });
    expect(gestureTransform(el)).toEqual({ k: 2.5, x: -30, y: -15 });

    chart.destroy();
    el.remove();
  });

  it("does not re-seed on the gesture's own frames — no behaviour.transform apply per zoom frame", async () => {
    const el = host();
    const chart = plot(el, { width: 240, height: 180, backend: "webgl" });
    await chart.whenReady();
    chart.points("pts", [{ x: 0, y: 0 }], { x: (d) => d.x, y: (d) => d.y, radius: 4, fill: "#333" });

    // Count how often the engine re-seeds d3-zoom, by spying on the protected hook through the
    // instance. A gesture frame must NOT re-seed: that call is already in step with d3-zoom, and
    // putting a `behavior.transform` apply on the interaction path would be per-frame work on a
    // continuous pointer interaction (AGENTS.md §5).
    const engine = chart as unknown as { syncZoomToView: () => void };
    const original = engine.syncZoomToView.bind(chart);
    let syncs = 0;
    engine.syncZoomToView = () => { syncs++; original(); };

    chart.enableZoom([0.5, 40]);
    const afterEnable = syncs;

    // Drive the zoom handler the way d3-zoom does, via a real wheel gesture.
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 8; i++) {
      el.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + 120, clientY: r.top + 90, deltaY: -60, bubbles: true, cancelable: true }));
    }
    const duringGesture = syncs - afterEnable;
    expect(duringGesture, "a zoom frame re-seeded d3-zoom — that is per-frame work on the interaction path").toBe(0);

    // The gesture actually moved the view (otherwise the assertion above is vacuous).
    expect(gestureTransform(el).k).toBeGreaterThan(1);

    // …while a programmatic call still re-seeds exactly once.
    chart.setTransform({ k: 3, x: -10, y: -10 });
    expect(syncs - afterEnable - duringGesture).toBe(1);

    chart.destroy();
    el.remove();
  });
});
