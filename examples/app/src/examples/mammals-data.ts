import type { TreeNode } from "./tree.js";
import type { ClustersPerSpecies } from "./parsimony.js";

/**
 * Synthetic data for the Infomap Bioregions example. A procedurally generated mammal
 * phylogeny (binomial names, dated branches) plus per-species bioregion distributions
 * that cluster phylogenetically — most species in one region, some spilling into a
 * second — so the Fitch reconstruction (and, later, the binned occurrence field) has
 * real structure. Everything is deterministic for a given seed.
 */

/** The six WWF-style biogeographic realms, used as default bioregions. */
export const REGION_NAMES = ["Nearctic", "Neotropic", "Palearctic", "Afrotropic", "Indomalaya", "Australasia"];

/** mulberry32 — small, fast, seedable PRNG so trees/assignments are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENERA = [
  "Petrogale", "Macropus", "Mus", "Rattus", "Sorex", "Myotis", "Canis", "Felis", "Bos", "Cervus",
  "Sciurus", "Lemur", "Pteropus", "Dasyurus", "Tupaia", "Echimys", "Crocidura", "Apodemus", "Microtus",
  "Tamias", "Vulpes", "Mustela", "Lepus", "Ovis", "Equus", "Marmota", "Galago", "Nycticebus", "Tarsius", "Bradypus",
];
const EPITHETS = [
  "xanthopus", "robustus", "major", "minor", "orientalis", "borealis", "australis", "silvestris",
  "montanus", "fuscus", "albus", "niger", "rufus", "gracilis", "elegans", "domesticus", "campestris",
  "nivalis", "palustris", "arboreus", "littoralis", "insularis", "pictus", "vagans", "concolor", "sylvaticus",
];

/**
 * Build a dated bifurcating tree with exactly `nTips` leaves (same age model as
 * tree.makeTree: tips at time 0, internal nodes older). Leaves get binomial names; a
 * clade tends to share a genus (switching with small probability), echoing real
 * taxonomy. Deterministic for `seed`.
 */
export function makeMammalTree(nTips: number, seed = 1): TreeNode {
  const rnd = mulberry32(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const used = new Set<string>();
  const uniqueName = (genus: string): string => {
    let name = `${genus} ${pick(EPITHETS)}`;
    while (used.has(name)) name = `${genus} ${pick(EPITHETS)}${used.size}`;
    used.add(name);
    return name;
  };

  const build = (n: number, age: number, parentAge: number, genus: string, group: number): TreeNode => {
    const length = parentAge - age;
    if (n <= 1) return { name: uniqueName(genus), group, length, time: 0 };
    const jitter = (rnd() - 0.5) * n * 0.4;
    const left = Math.max(1, Math.min(n - 1, Math.round(n / 2 + jitter)));
    const genusL = rnd() < 0.3 ? pick(GENERA) : genus; // occasionally start a new genus
    const genusR = rnd() < 0.3 ? pick(GENERA) : genus;
    const groupL = rnd() < 0.22 ? (group + 1) % 10 : group;
    const groupR = rnd() < 0.22 ? (group + 1) % 10 : group;
    const ageL = left <= 1 ? 0 : age * (0.3 + rnd() * 0.5);
    const ageR = n - left <= 1 ? 0 : age * (0.3 + rnd() * 0.5);
    return {
      name: "node", group, length, time: age,
      children: [build(left, ageL, age, genusL, groupL), build(n - left, ageR, age, genusR, groupR)],
    };
  };
  return build(Math.max(2, nTips), 1, 1, pick(GENERA), 0);
}

/**
 * Assign each leaf a bioregion distribution that clusters phylogenetically: a clade
 * inherits a "home" region, shifting to a random region with small probability
 * (vicariance). ~18% of species also spill into a second region. `count` is a synthetic
 * number of occurrences — large in the home region, small in the spillover one — so the
 * aggregated distribution (and the pie wedges) vary in size. Returns the
 * `clustersPerSpecies` map consumed by `calcMaximumParsimony` / `aggregateClusters`.
 * Deterministic for `seed`.
 */
export function assignBioregions(root: TreeNode, nRegions = REGION_NAMES.length, seed = 1): ClustersPerSpecies {
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const out: ClustersPerSpecies = {};
  const walk = (node: TreeNode, home: number): void => {
    const h = rnd() < 0.15 ? Math.floor(rnd() * nRegions) : home; // vicariance shift
    if (!node.children) {
      const clusters = [{ clusterId: h, count: 5 + Math.floor(rnd() * 26) }]; // home: 5–30 occurrences
      if (rnd() < 0.18) {
        const other = (h + 1 + Math.floor(rnd() * (nRegions - 1))) % nRegions; // spillover: 1–6
        clusters.push({ clusterId: other, count: 1 + Math.floor(rnd() * 6) });
      }
      out[node.name] = { totCount: clusters.reduce((s, c) => s + c.count, 0), clusters };
      return;
    }
    node.children.forEach((c) => walk(c, h));
  };
  walk(root, Math.floor(rnd() * nRegions));
  return out;
}
