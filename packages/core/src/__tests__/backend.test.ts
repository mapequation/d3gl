import { describe, it, expect } from "vitest";
import type { Backend, RenderLayer, ViewTransform } from "../backend.js";

describe("Backend interface", () => {
  it("an in-memory stub satisfies the interface", () => {
    const calls: string[] = [];
    const stub: Backend = {
      setLayers: (l: RenderLayer[]) => calls.push(`setLayers:${l.length}`),
      updateLayer: (n) => calls.push(`updateLayer:${n}`),
      setTransform: (t: ViewTransform) => calls.push(`t:${t.k}`),
      render: () => calls.push("render"),
      toPNG: () => "data:image/png;base64,",
      toSVG: () => "<svg></svg>",
      destroy: () => calls.push("destroy"),
    };
    stub.setTransform({ k: 2, x: 0, y: 0 });
    stub.render();
    expect(calls).toEqual(["t:2", "render"]);
  });
});
