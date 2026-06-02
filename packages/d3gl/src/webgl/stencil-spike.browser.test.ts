import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Model } from "@luma.gl/engine";

// SPIKE (spec Task 0): prove luma.gl v9.3 stencil-buffer clipping works end to end.
const W = 64;
const H = 64;

const VS = `#version 300 es
precision highp float;
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }`;

function quad(x0: number, x1: number): Float32Array {
  return new Float32Array([x0, -1, x1, -1, x1, 1, x0, -1, x1, 1, x0, 1]);
}

function makeModel(device: any, verts: Float32Array, color: number[], parameters: object) {
  const positionBuffer = device.createBuffer({ data: verts });
  return new Model(device, {
    vs: VS,
    fs: FS,
    bufferLayout: [{ name: "a_pos", format: "float32x2" }],
    attributes: { a_pos: positionBuffer },
    uniforms: { u_color: color },
    topology: "triangle-list",
    vertexCount: 6,
    parameters,
  });
}

describe("luma stencil clipping spike", () => {
  it("probes clear + mask + clipped", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const device = await luma.createDevice({
      adapters: [webgl2Adapter],
      type: "webgl",
      createCanvasContext: { canvas, useDevicePixels: false },
    });

    const read = (fb: any, x: number): number =>
      device.readPixelsToArrayWebGL(fb, {
        sourceX: x,
        sourceY: Math.floor(H * 0.5),
        sourceWidth: 1,
        sourceHeight: 1,
      })[0]!;

    // Run a fresh framebuffer through a sequence of draws; return red channel L/R.
    const probe = (draws: ((fb: any) => Model)[]): [number, number] => {
      const fb = device.createFramebuffer({
        width: W,
        height: H,
        colorAttachments: ["rgba8unorm"],
        depthStencilAttachment: "depth24plus-stencil8",
      });
      const pass = device.beginRenderPass({ framebuffer: fb, clearColor: [0, 0, 0, 1], clearStencil: 0 });
      for (const make of draws) make(fb).draw(pass);
      pass.end();
      device.submit();
      const out: [number, number] = [read(fb, Math.floor(W * 0.25)), read(fb, Math.floor(W * 0.75))];
      fb.destroy();
      return out;
    };

    const COMMON = {
      depthCompare: "always" as const,
      depthWriteEnabled: false,
      stencilReadMask: 0x01,
      stencilWriteMask: 0x01,
      stencilFailOperation: "keep" as const,
      stencilDepthFailOperation: "keep" as const,
    };
    const clippedEq0 = () => makeModel(device, quad(-1, 1), [1, 0, 0, 1], { ...COMMON, stencilCompare: "equal", stencilPassOperation: "keep" });
    const clippedNe0 = () => makeModel(device, quad(-1, 1), [1, 0, 0, 1], { ...COMMON, stencilCompare: "not-equal", stencilPassOperation: "keep" });
    const maskLeft = () => makeModel(device, quad(-1, 0), [0, 0, 0, 0], { ...COMMON, stencilCompare: "equal", stencilPassOperation: "increment-clamp" });

    const A = probe([clippedEq0]); // clear then eq0: stencil==0 everywhere => red both halves
    const B = probe([clippedNe0]); // clear then ne0: stencil!=0 nowhere => black both halves
    const C = probe([maskLeft, clippedNe0]); // mask left then ne0: left red, right black

    // Clear zeroes stencil bit 0 across the buffer:
    expect(A[0]).toBeGreaterThan(200);
    expect(A[1]).toBeGreaterThan(200);
    expect(B[0]).toBeLessThan(40);
    expect(B[1]).toBeLessThan(40);
    // The mask clips the draw to the left half (pixel-accurate, not whole-cell):
    expect(C[0]).toBeGreaterThan(200);
    expect(C[1]).toBeLessThan(40);

    device.destroy();
  });
});
