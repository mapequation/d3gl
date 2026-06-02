import type { TreeNode } from "./tree.js";

/**
 * Fitch maximum-parsimony reconstruction of ancestral bioregion ranges (Fitch 1971),
 * plus occurrence-count aggregation. A region is `{clusterId, count}` — a bioregion id
 * and a count of species occurrences in it. Two distinct per-node products:
 *
 *  - `node.ranges`  — the reconstructed ancestral *range set* (membership): at a tip the
 *                     species' present regions, at an internal node the most-parsimonious
 *                     ancestral set. Counts here are presence (1); membership is the point.
 *  - `node.clusters`— the occurrence-count *distribution*: leaf counts summed up the tree,
 *                     sorted by descending count. Used to size the pie wedges.
 *
 * Fitch's two-phase algorithm. Preliminary phase (post-order): a leaf's set is its
 * regions; an internal node's set is the intersection of its children's sets, or — when
 * that is empty — their union (flagged `byUnion`). Final phase (pre-order), applying the
 * classic rules to each non-root node given its already-final parent set:
 *
 *   I.   If the preliminary set contains all regions of the parent's final set, go to II,
 *        else go to III.
 *   II.  (diminished ambiguity) Drop every region not in the parent's final set — i.e. keep
 *        the intersection with the parent. Done.
 *   III. If the preliminary set was formed by a union of its children's sets, go to IV,
 *        else go to V.
 *   IV.  (expanded ambiguity) Add every parent-final region not already present — i.e. the
 *        union with the parent. Done.
 *   V.   (encompassing ambiguity) Add any region not already present that is in BOTH the
 *        parent's final set AND at least one child's preliminary set. Done.
 *
 * NOTE: this fixes a bug in the bioregions1 reference, whose final phase tests
 * `node.byUnion` (always undefined — the flag lives on `node.clusters.byUnion`), so Rule IV
 * never fires and Rule V adds nothing. That produces incorrect sets for Fitch figs 2d/2f
 * (e.g. fig 2d node 0 wrongly collapses to {A,C} instead of the correct {A,C,G}). We follow
 * the written rules above, verified against the most-parsimonious reconstructions.
 */
export interface Region { clusterId: number; count: number; }
export interface RegionSet { totCount: number; clusters: Region[]; byUnion?: boolean; }
export type ClustersPerSpecies = Record<string, RegionSet>;

const idSet = (s: Region[]): Set<number> => new Set(s.map((r) => r.clusterId));
/** Regions of `a` also present in `b` (by clusterId), preserving `a`'s order. */
function intersectBy(a: Region[], b: Region[]): Region[] { const bi = idSet(b); return a.filter((r) => bi.has(r.clusterId)); }
/** Regions of `a`, then regions of `b` not already in `a`. */
function unionBy(a: Region[], b: Region[]): Region[] { const ai = idSet(a); return a.concat(b.filter((r) => !ai.has(r.clusterId))); }
const set = (clusters: Region[], byUnion?: boolean): RegionSet => ({ totCount: clusters.length, clusters, byUnion });

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
      node.ranges = set(cl ? cl.clusters.map((r) => ({ clusterId: r.clusterId, count: 1 })) : []);
      return;
    }
    const childSets = node.children.map((c) => c.ranges!.clusters);
    let anc = childSets.reduce((acc, s) => intersectBy(acc, s));
    const byUnion = anc.length === 0;
    if (byUnion) anc = childSets.reduce((acc, s) => unionBy(acc, s), [] as Region[]);
    node.ranges = set(anc, byUnion);
  });
  return root;
}

/** Top-down pass applying Fitch's rules I–V (see the module doc). Root and leaves are
 *  already final. Children are visited after their parent, so a node's Rule-V lookup of
 *  its children's *preliminary* sets reads them before they are overwritten. */
export function calcMaximumParsimonyFinalPhase(root: TreeNode): TreeNode {
  visitPreOrder(root, (node, parent) => {
    if (!parent || !node.children) return;
    const prelim = node.ranges!.clusters;
    const pfinal = parent.ranges!.clusters;
    if (intersectBy(prelim, pfinal).length === pfinal.length) {
      node.ranges = set(intersectBy(prelim, pfinal)); // I → II (diminished)
    } else if (node.ranges!.byUnion) {
      node.ranges = set(unionBy(prelim, pfinal)); // III → IV (expanded)
    } else {
      // III → V (encompassing): add parent regions present in ≥1 child's preliminary set.
      const childrenUnion = node.children.map((c) => c.ranges!.clusters).reduce((a, b) => unionBy(a, b), [] as Region[]);
      node.ranges = set(unionBy(prelim, intersectBy(pfinal, childrenUnion)));
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
 * Sum occurrence counts up the tree into `node.clusters`, sorted by descending count (ties
 * broken by clusterId). A leaf's counts come from the data; an internal node's count for a
 * region is the sum over its descendants. Mirrors bioregions1 `_aggregateClusters`, minus
 * the fraction-threshold "rest" grouping.
 */
export function aggregateClusters(root: TreeNode, clustersPerSpecies: ClustersPerSpecies): TreeNode {
  const sorted = (clusters: Region[], totCount: number): RegionSet => ({
    totCount,
    clusters: [...clusters].sort((a, b) => b.count - a.count || a.clusterId - b.clusterId),
  });
  visitPostOrder(root, (node) => {
    if (!node.children) {
      const cl = clustersPerSpecies[node.name];
      const clusters = cl ? cl.clusters.map((r) => ({ clusterId: r.clusterId, count: r.count })) : [];
      node.clusters = sorted(clusters, clusters.reduce((s, r) => s + r.count, 0));
      return;
    }
    const agg = new Map<number, number>();
    let totCount = 0;
    for (const child of node.children) {
      for (const r of child.clusters!.clusters) {
        agg.set(r.clusterId, (agg.get(r.clusterId) ?? 0) + r.count);
        totCount += r.count;
      }
    }
    node.clusters = sorted([...agg].map(([clusterId, count]) => ({ clusterId, count })), totCount);
  });
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
