export interface TreeNode {
  name: string;
  group: number;
  /** Branch length = parent.time - this.time (time elapsed along the branch). */
  length: number;
  /** Age before present, in [0, 1]. Tips are at 0 (the present); the root is oldest. */
  time: number;
  children?: TreeNode[];
}

/** Deterministic LCG so trees are stable across renders (no Math.random in render path). */
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff; }

/**
 * Build a roughly-balanced bifurcating tree with exactly `tips` leaves by
 * recursively splitting the tip count in two (with a little jitter so it looks
 * natural rather than perfectly symmetric). Branch lengths are random — a
 * phylogram, not a cladogram. Deterministic for a given seed.
 */
export function makeTree(tips: number, seed = 42): TreeNode {
  const rnd = lcg(seed);
  let leaf = 0;
  let groupCounter = 0;
  // Ultrametric ("dated") tree: every tip is at time 0 (the present); internal
  // nodes carry a divergence age younger than their parent's. `build` takes this
  // node's age and the parent's age (to compute the branch length).
  const build = (n: number, age: number, parentAge: number, group: number): TreeNode => {
    const length = parentAge - age;
    if (n <= 1) {
      leaf++;
      return { name: `tip_${leaf}`, group, length, time: 0 };
    }
    const jitter = (rnd() - 0.5) * n * 0.4;
    const left = Math.max(1, Math.min(n - 1, Math.round(n / 2 + jitter)));
    // Occasionally start a new colour group so tips cluster by clade.
    const g1 = rnd() < 0.22 ? ++groupCounter % 10 : group;
    const g2 = rnd() < 0.22 ? ++groupCounter % 10 : group;
    // Children diverge at younger ages (closer to the present); leaves sit at 0.
    const ageL = left <= 1 ? 0 : age * (0.3 + rnd() * 0.5);
    const ageR = n - left <= 1 ? 0 : age * (0.3 + rnd() * 0.5);
    return {
      name: "node", group, length, time: age,
      children: [build(left, ageL, age, g1), build(n - left, ageR, age, g2)],
    };
  };
  return build(Math.max(2, tips), 1, 1, 0);
}
