/**
 * The repulsion program's source shape where it matters for speed on real GPUs but no CI device can
 * measure it (#354). CI runs SwiftShader, which compiles both shapes alike.
 */
import { describe, expect, it } from "vitest";
import { repulsionFs } from "../passes/repulsion.js";

describe("repulsionFs — the flat exact loop's bound (#354)", () => {
  it("with one segment, the exact loop reads its bound from the u_count uniform in the loop condition", () => {
    // ANGLE Metal compiles the loop about 2% slower when its bound comes from a texture fetch (the
    // segment's row) or through a function parameter: 3.26 → 3.33 ms per draw at N = 4096 on an
    // M1 Max. The flat layout's single segment is [0, count) by construction, so it uses the uniform.
    const fs = repulsionFs({ singleSegment: true, levelCount: 0, exact: true });
    expect(fs).toMatch(/vec2 exactRepulsion\([^)]*\) \{[^}]*?#ifdef SINGLE_SEGMENT\s+for \(int j = 0; j < u_count; j\+\+\)/);
  });

  it("with many segments, the exact loop runs over the segment's own slots from its row", () => {
    const fs = repulsionFs({ singleSegment: false, levelCount: 0, exact: true });
    expect(fs).not.toContain("#define SINGLE_SEGMENT");
    expect(fs).toMatch(/int start = int\(info\.x\);\s+int end = start \+ int\(info\.y\);\s+for \(int j = start; j < end; j\+\+\)/);
  });
});
