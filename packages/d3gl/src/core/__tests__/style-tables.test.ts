import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

describe("Scene.styleTables / Scene.drawableOf", () => {
  const build = (): Scene => {
    const scene = new Scene();
    scene.group("g", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10));
      g.point("b", 20, 20, 3);
    });
    scene.setFill("g", "a", "rgb(255,0,0)");
    return scene;
  };

  it("returns just the per-drawable tables, detached from the scene", () => {
    const scene = build();
    const t = scene.styleTables("g");
    expect(t.fillColors).toBeInstanceOf(Uint8Array);
    expect(t.fillColors.length).toBe(2 * 4);
    expect([...t.fillColors.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(t.flags.length).toBe(2);
    // Detached snapshot: later scene writes don't mutate it.
    scene.setFill("g", "a", "rgb(0,255,0)");
    expect(t.fillColors[1]).toBe(0);
  });

  it("looks up one drawable by id in O(1), null when absent", () => {
    const scene = build();
    const d = scene.drawableOf("g", "a");
    expect(d?.id).toBe("a");
    expect(d?.fill).toEqual([255, 0, 0, 255]);
    expect(d?.subpaths.length).toBeGreaterThan(0);
    const p = scene.drawableOf("g", "b");
    expect(p?.circles).toEqual([{ x: 20, y: 20, r: 3 }]);
    expect(scene.drawableOf("g", "missing")).toBeNull();
  });
});

describe("Scene.setFill / writeColor — transparent color handling", () => {
  const buildScene = (): Scene => {
    const scene = new Scene();
    scene.group("g", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10));
    });
    return scene;
  };

  it('writes [0,0,0,0] for "transparent"', () => {
    const scene = buildScene();
    scene.setFill("g", "a", "transparent");
    const d = scene.drawableOf("g", "a");
    expect(d?.fill).toEqual([0, 0, 0, 0]);
  });

  it('writes [0,0,0,0] for "rgba(255, 0, 0, 0)" (fully transparent with non-zero RGB)', () => {
    const scene = buildScene();
    scene.setFill("g", "a", "rgba(255, 0, 0, 0)");
    const d = scene.drawableOf("g", "a");
    expect(d?.fill).toEqual([0, 0, 0, 0]);
  });

  it("styleTables also reflects the [0,0,0,0] write", () => {
    const scene = buildScene();
    // First set a visible color, then overwrite with transparent.
    scene.setFill("g", "a", "rgb(255,0,0)");
    scene.setFill("g", "a", "transparent");
    const t = scene.styleTables("g");
    expect([...t.fillColors.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it('throws "invalid color" for an unparseable string', () => {
    const scene = buildScene();
    expect(() => scene.setFill("g", "a", "not-a-color")).toThrow("invalid color");
  });
});
