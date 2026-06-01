import type { TreeNode } from "./tree.js";

/**
 * Fitch maximum-parsimony reconstruction of ancestral bioregion ranges, ported
 * (typed) from Infomap Bioregions v1 (`geoTreeUtils.js`). A node's range is a sparse
 * set of `{clusterId, count}` (a bioregion id and its presence count). At tips the set
 * is the species' current distribution; at internal nodes it is the reconstructed
 * ancestral range.
 *
 * Faithfulness note: the reference stores the union flag on `node.clusters.byUnion`
 * but its final phase reads `node.byUnion` (undefined), so the "expanded ambiguity"
 * (Rule IV) branch never fires and Rule V's additions are always empty — a non-Rule-II
 * node keeps its preliminary set. This reproduces Fitch's published fig. 2 results and
 * the reference test suite exactly (genuine Rule IV would, e.g., wrongly expand fig 2d's
 * node 0 to {A,C,G}). We mirror that behavior intentionally.
 */
export interface Region { clusterId: number; count: number; }
export interface RegionSet { totCount: number; clusters: Region[]; byUnion?: boolean; }
export type ClustersPerSpecies = Record<string, RegionSet>;

const idSet = (s: Region[]): Set<number> => new Set(s.map((r) => r.clusterId));
/** Regions of `a` also present in `b` (by clusterId), preserving `a`'s order. */
function intersectBy(a: Region[], b: Region[]): Region[] { const bi = idSet(b); return a.filter((r) => bi.has(r.clusterId)); }
/** Regions of `a`, then regions of `b` not already in `a`. */
function unionBy(a: Region[], b: Region[]): Region[] { const ai = idSet(a); return a.concat(b.filter((r) => !ai.has(r.clusterId))); }

function visitPostOrder(node: TreeNode, cb: (n: TreeNode) => void): void {
  node.children?.forEach((c) => visitPostOrder(c, cb));
  cb(node);
}
function visitPreOrder(node: TreeNode, cb: (n: TreeNode, parent: TreeNode | null) => void, parent: TreeNode | null = null): void {
  cb(node, parent);
  node.children?.forEach((c) => visitPreOrder(c, cb, node));
}

/** Bottom-up pass: leaves presence-count their regions; each internal node takes the
 *  intersection of its children's sets, falling back to the union (flagged) if empty. */
export function calcMaximumParsimonyPreliminaryPhase(root: TreeNode, clustersPerSpecies: ClustersPerSpecies): TreeNode {
  visitPostOrder(root, (node) => {
    if (!node.children) {
      const cl = clustersPerSpecies[node.name];
      const clusters = cl ? cl.clusters.map((r) => ({ clusterId: r.clusterId, count: 1 })) : [];
      node.ranges = { totCount: clusters.length, clusters };
      return;
    }
    const childSets = node.children.map((c) => c.ranges!.clusters);
    let anc = childSets.reduce((acc, s) => intersectBy(acc, s));
    const byUnion = anc.length === 0;
    if (byUnion) anc = childSets.reduce((acc, s) => unionBy(acc, s), [] as Region[]);
    node.ranges = { totCount: anc.length, clusters: anc, byUnion };
  });
  return root;
}

/** Top-down pass: refine each non-root internal node against its parent. When the node
 *  set contains all of the parent's regions, restrict to the intersection (Rule II,
 *  "diminished ambiguity"); otherwise the preliminary set stands (see the faithfulness
 *  note above). Root and leaves are already final. */
export function calcMaximumParsimonyFinalPhase(root: TreeNode): TreeNode {
  visitPreOrder(root, (node, parent) => {
    if (!parent || !node.children) return;
    const pset = parent.ranges!.clusters;
    const inter = intersectBy(node.ranges!.clusters, pset);
    if (inter.length === pset.length) {
      node.ranges = { totCount: inter.length, clusters: inter };
    }
  });
  return root;
}

export function calcMaximumParsimony(root: TreeNode, clustersPerSpecies: ClustersPerSpecies): TreeNode {
  calcMaximumParsimonyPreliminaryPhase(root, clustersPerSpecies);
  calcMaximumParsimonyFinalPhase(root);
  return root;
}

/**
 * Post-order aggregation of `speciesCount` = number of subtended terminals (the Fig. 3
 * branch-thickness metric). With no `presence` map every leaf counts as one; with one,
 * a leaf counts only if present (absent species contribute 0).
 */
export function aggregateSpeciesCount(root: TreeNode, presence?: Record<string, number>): TreeNode {
  visitPostOrder(root, (node) => {
    if (!node.children) {
      node.speciesCount = presence ? (presence[node.name] ? 1 : 0) : 1;
      return;
    }
    node.speciesCount = node.children.reduce((sum, c) => sum + (c.speciesCount ?? 0), 0);
  });
  return root;
}
