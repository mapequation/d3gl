export interface TreeNode { name: string; group: number; length: number; children?: TreeNode[]; }

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
  let group = 0;
  const build = (n: number, inherited: number): TreeNode => {
    const length = 0.15 + rnd() * 0.85;
    if (n <= 1) {
      leaf++;
      return { name: `tip_${leaf}`, group: inherited, length };
    }
    // Split into two parts near half, with jitter; clades keep a stable group id.
    const jitter = (rnd() - 0.5) * n * 0.4;
    const left = Math.max(1, Math.min(n - 1, Math.round(n / 2 + jitter)));
    // Occasionally start a new colour group so tips cluster by clade.
    const g = rnd() < 0.25 ? group++ % 10 : inherited;
    return { name: "node", group: g, length, children: [build(left, g), build(n - left, g)] };
  };
  return build(Math.max(2, tips), 0);
}
