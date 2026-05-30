import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Model } from "@luma.gl/engine";

const WIDTH = 64;
const HEIGHT = 64;

async function createTestDevice() {
  // Create device without a canvas (will auto-create an offscreen-style context)
  // We use createCanvasContext with a fresh canvas to get a WebGL2 context
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.appendChild(canvas);

  const device = await luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });

  return { device, canvas };
}

describe("luma.gl v9 WebGL2 smoke tests", () => {
  it("test 1: clear to red and read back center pixel", async () => {
    const { device, canvas } = await createTestDevice();

    // Create an offscreen framebuffer with a texture color attachment
    // This is what readPixelsToArrayWebGL needs (it requires colorAttachments[0].texture)
    const framebuffer = device.createFramebuffer({
      width: WIDTH,
      height: HEIGHT,
      colorAttachments: ["rgba8unorm"],
    });

    // Clear to red using the explicit framebuffer
    const pass = device.beginRenderPass({
      framebuffer,
      clearColor: [1, 0, 0, 1],
    });
    pass.end();
    device.submit();

    // Read back the center pixel from the texture-backed framebuffer
    const pixels = device.readPixelsToArrayWebGL(framebuffer, {
      sourceX: WIDTH / 2,
      sourceY: HEIGHT / 2,
    });

    // pixels is a Uint8Array [R, G, B, A]
    expect(pixels[0]).toBeGreaterThan(200); // R ~ 255
    expect(pixels[1]).toBeLessThan(10);     // G ~ 0
    expect(pixels[2]).toBeLessThan(10);     // B ~ 0

    framebuffer.destroy();
    device.destroy();
    canvas.remove();
  });

  it("test 2: draw a green triangle and read back center pixel", async () => {
    const { device, canvas } = await createTestDevice();

    // Create explicit framebuffer for rendering and readback
    const framebuffer = device.createFramebuffer({
      width: WIDTH,
      height: HEIGHT,
      colorAttachments: ["rgba8unorm"],
    });

    // Full-screen triangle vertices (clip space)
    const positions = new Float32Array([
      -1, -1,
       3, -1,
      -1,  3,
    ]);

    const positionBuffer = device.createBuffer({ data: positions });

    const model = new Model(device, {
      vs: /* glsl */ `\
#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`,
      fs: /* glsl */ `\
#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0, 1.0, 0.0, 1.0);
}
`,
      bufferLayout: [
        { name: "position", format: "float32x2" },
      ],
      attributes: { position: positionBuffer },
      vertexCount: 3,
      topology: "triangle-list",
    });

    const pass = device.beginRenderPass({
      framebuffer,
      clearColor: [0, 0, 0, 1],
    });
    model.draw(pass);
    pass.end();
    device.submit();

    // Read back center pixel
    const pixels = device.readPixelsToArrayWebGL(framebuffer, {
      sourceX: WIDTH / 2,
      sourceY: HEIGHT / 2,
    });

    // Should be green [0, 255, 0, 255]
    expect(pixels[0]).toBeLessThan(10);      // R ~ 0
    expect(pixels[1]).toBeGreaterThan(200);  // G ~ 255
    expect(pixels[2]).toBeLessThan(10);      // B ~ 0

    model.destroy();
    positionBuffer.destroy();
    framebuffer.destroy();
    device.destroy();
    canvas.remove();
  });
});
