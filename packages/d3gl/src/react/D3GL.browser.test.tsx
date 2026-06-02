import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Scene } from "../core/index.js";
import { D3GL } from "./D3GL.js";
import type { MapController } from "./controller.js";

const W = 64;
const H = 64;

function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  scene.setFill("cells", "a", "#ff0000");
  scene.setFill("cells", "b", "#0000ff");
  return scene;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

describe("<D3GL>", () => {
  it("mounts, builds the GPU map, and renders the group's colors", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const scene = twoHalves();

    const controller = await new Promise<MapController>((resolve, reject) => {
      root = createRoot(container!);
      root.render(
        React.createElement(D3GL, {
          width: W,
          height: H,
          transform: { k: 1, x: 0, y: 0 },
          groups: [{ name: "cells", buffers: scene.buffers("cells") }],
          onReady: resolve,
          onError: reject,
        }),
      );
    });

    const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBe(W);
    expect(canvas.height).toBe(H);

    expect(controller.readPixel(16, 32)[0]).toBeGreaterThan(200); // red
    expect(controller.readPixel(48, 32)[2]).toBeGreaterThan(200); // blue
  });
});
