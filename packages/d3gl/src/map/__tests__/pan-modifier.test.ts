import { describe, it, expect } from "vitest";
import { panModifierFor } from "../pan-modifier.js";

/**
 * The force-pan modifier (#178) is the platform's command key: ⌘ on Apple platforms, Ctrl
 * everywhere else. Ctrl can't be it on a Mac — ctrl-click opens the context menu there, which is
 * why d3-zoom refuses Ctrl-drag by default.
 */
describe("panModifierFor (#178)", () => {
  it("is ⌘ (metaKey) on Apple platforms", () => {
    for (const p of ["MacIntel", "Macintosh", "iPhone", "iPad", "iPod touch"]) {
      expect(panModifierFor(p), p).toBe("metaKey");
    }
  });

  it("is Ctrl (ctrlKey) everywhere else", () => {
    for (const p of ["Win32", "Win64", "Linux x86_64", "Linux armv8l", "X11", "CrOS x86_64"]) {
      expect(panModifierFor(p), p).toBe("ctrlKey");
    }
  });

  it("falls back to Ctrl when the platform is unknown (empty string, no navigator)", () => {
    expect(panModifierFor("")).toBe("ctrlKey");
  });

  it("recognises a user-agent string too (the fallback when navigator.platform is empty)", () => {
    expect(panModifierFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe("metaKey");
    expect(panModifierFor("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("ctrlKey");
  });
});
