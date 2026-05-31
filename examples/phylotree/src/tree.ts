export interface TreeNode { name: string; group: number; length: number; children?: TreeNode[]; }

/** Deterministic LCG so trees are stable across renders (no Math.random in render path). */
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff; }

/** Build a random bifurcating tree with ~`tips` leaves. */
export function makeTree(tips: number, seed = 42): TreeNode {
  const rnd = lcg(seed);
  let leafCount = 0;
  const build = (depth: number): TreeNode => {
    const length = 0.2 + rnd() * 0.8;
    const group = Math.floor(rnd() * 8);
    // Stop splitting once we have enough leaves or got deep.
    if (leafCount >= tips || depth > 40 || (depth > 2 && rnd() < 0.18 && leafCount < tips)) {
      leafCount++;
      return { name: `tip_${leafCount}`, group, length };
    }
    return { name: `node`, group, length, children: [build(depth + 1), build(depth + 1)] };
  };
  // Ensure at least 2 tips.
  const root = build(0);
  return root.children ? root : { name: "root", group: 0, length: 0, children: [root, build(0)] };
}
