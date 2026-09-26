import type { InstancedLinesData, InstancedArrowsData } from "../../core/index.js";
import { boundaryCircle, type LODTree } from "../lod.js";
import type { SuperEdgeStyleResolved, SuperEdgesData } from "../glyphs.js";

/**
 * The super-edge gather as it was before #364, when its per-call scratch was `Map`s and `Set`s keyed by
 * `a · tree.size + b` (`flowByPair`, `cover`, `proj`, `anchor`, `claimed`, `claimedEnds`). Kept verbatim
 * as the reference the typed-array gather must reproduce element for element (`super-edges-memo.test.ts`,
 * `super-edges-depth.test.ts`) and as the baseline its per-frame cost is measured against
 * (`super-edges-perf.test.ts`). Test-only.
 */

/** Path-strip samples for a smooth bent link, as `glyphs.ts` uses. */
const BENT_SAMPLES = 24;

export interface MapSuperEdgesScratch {
  /** Generation-stamped frontier membership, length ≥ tree.size — grown on demand, never per frame. */
  seen: Int32Array;
  /** Current generation stamp; bumped once per `superEdges` call. */
  gen: number;
  /** Gathered edge sources/targets/flows (parallel grow-arrays; only a call-local prefix is valid). */
  aS: Int32Array;
  bS: Int32Array;
  wS: Float64Array;
  /** Directed-pair flow lookup for reciprocal half-arrow widths — cleared per call. */
  flowByPair: Map<number, number>;
  /** Cross-level (#139) nearest-present-ancestor memo + projected-pair sums — cleared per call. */
  cover: Map<number, number>;
  proj: Map<number, number>;
  /** Module links anchored at an expanded module's boundary (#329): pair → summed flow — cleared per call. */
  anchor: Map<number, number>;
  /** Flow a finer drawn pair already carries, by the off-screen pair that also holds it (pair → summed
   *  flow), and that pair's non-present ends — cleared per call. @see `superEdges` */
  claimed: Map<number, number>;
  claimedEnds: Set<number>;
}

/** Fresh {@link MapSuperEdgesScratch}. The network engine keeps ONE per instance; `superEdges`
 *  falls back to a throwaway one when none is passed (backward-compatible, but then per-call O(tree.size)). */
export function makeMapSuperEdgesScratch(): MapSuperEdgesScratch {
  return { seen: new Int32Array(0), gen: 0, aS: new Int32Array(256), bS: new Int32Array(256), wS: new Float64Array(256), flowByPair: new Map(), cover: new Map(), proj: new Map(), anchor: new Map(), claimed: new Map(), claimedEnds: new Set() };
}

/** The Map-based `superEdges` of perf/lod-streaming-frame-waste (#342), verbatim but for its name. */
export function superEdgesMapReference(
  tree: LODTree,
  frontier: Uint32Array,
  style: SuperEdgeStyleResolved,
  view: { minX: number; maxX: number; minY: number; maxY: number },
  scratch?: MapSuperEdgesScratch,
): SuperEdgesData {
  const off = tree.superEdgeOffset;
  const tgt = tree.superEdgeTarget;
  const flw = tree.superEdgeFlow;
  if (!off || !tgt || !flw) return { ids: [] };

  // #210: all working storage comes from the (reused) scratch. The only O(tree.size) cost is `seen`'s
  // one-time growth to this tree's size; per call, bumping the generation stamp replaces a clear.
  const sc = scratch ?? makeMapSuperEdgesScratch();
  if (sc.seen.length < tree.size) sc.seen = new Int32Array(tree.size); // grown once per tree (zero-filled ⇒ never equals a stamp ≥ 1)
  if (sc.gen === 0x7fffffff) { sc.seen.fill(0); sc.gen = 0; } // stamp wrap — once per 2^31 calls
  const seen = sc.seen;
  const gen = ++sc.gen; // seen[g] === gen ⇔ g is on this call's frontier
  for (let i = 0; i < frontier.length; i++) seen[frontier[i]!] = gen;
  // A neighbour is drawable if it's on the frontier, or its centroid is off-screen (the edge just exits
  // the view toward a real node) — an O(1) test, no cull margin needed. Off-frontier *on-screen*
  // neighbours (collapsed↔expanded) are skipped.
  const offScreen = (h: number): boolean => tree.cx[h]! < view.minX || tree.cx[h]! > view.maxX || tree.cy[h]! < view.minY || tree.cy[h]! > view.maxY;
  // Lift pairs (#325) join nodes at different depths. The shallower endpoint's rows hold one per lift level
  // for the same edge, so toward a NON-present neighbour a pair is followed only from its deeper end —
  // `deeper(h, g)` skips it from the shallower one. (No `depth` — a hand-built CSR — ⇒ all same-depth.)
  const dep = tree.depth;
  const deeper = (h: number, g: number): boolean => dep !== undefined && dep[h]! > dep[g]!;
  // A present lift pair whose shallower end is an AGGREGATE (a module-link endpoint): a cross-level
  // projection can land on the same pair (from an edge ending strictly inside it), so it is summed with the
  // projections rather than drawn on its own. A leaf has nothing inside it — graph-edge lift pairs draw direct.
  const merges = (g: number, h: number): boolean => dep !== undefined && dep[h] !== dep[g] && (dep[h]! < dep[g]! ? h : g) >= tree.leafCount;
  // The parent map, only when the cross-level pass (#139) runs below.
  const par = style.crossLevelEdges ? tree.parent : undefined;
  // The off-screen rule follows a pair toward a non-present, off-screen neighbour as if it lay outside the
  // cut. But an EXPANDED neighbour (an ancestor of present nodes whose centroid has scrolled off) holds
  // flow that finer pairs also draw: a present lift pair (#325), a cross-level projection (#139), an
  // anchored module link (#329). Each such pair between nodes at different depths `claim`s its flow
  // against the one off-screen pair that holds it too — its shallower (present) end paired with its deeper
  // end's ancestor at that depth — and after the gather that pair keeps only the rest: the flow toward
  // members not drawn (culled, decluttered), or nothing. O(depth) per claim; nothing when no pair claims.
  const up = tree.parent;
  const claimed = sc.claimed;
  const claimedEnds = sc.claimedEnds;
  claimed.clear();
  claimedEnds.clear();
  const claim = (a: number, b: number, w: number): void => {
    if (!dep || !up || dep[a] === dep[b]) return;
    const shallowA = dep[a]! < dep[b]!;
    const s = shallowA ? a : b;
    if (seen[s] !== gen) return; // a non-present shallower end: no off-screen pair holds it
    const ds = dep[s]!;
    let x = shallowA ? b : a;
    while (dep[x]! > ds) {
      x = up[x]!;
      if (seen[x] === gen) return; // a present node on the way (a cross-fade band): it draws its own pair
    }
    if (!offScreen(x)) return; // on-screen: the off-screen rule does not follow it
    const key = shallowA ? s * tree.size + x : x * tree.size + s;
    claimed.set(key, (claimed.get(key) ?? 0) + w);
    claimedEnds.add(x);
  };
  // Anchoring at expanded modules' boundaries (#329), only inside the cross-level pass. Edges from
  // `anchorStart` on are anchored links; an end is on its module's boundary iff `anchored(end)`: an
  // expanded module in view (stamped `-gen`) whose centre is on-screen. `anchorEnds` puts both ends
  // where they are drawn (a boundary end moved onto its circle, toward the other end, at radius 0) into
  // `ends` = [ax, ay, bx, by]. When the two circles overlap (routine for the centroid + extent fallback,
  // or with the other end's centre inside the ring), there is no gap to run the link across: it runs
  // between the circles' centres instead, so its flow is still drawn.
  const anc = style.anchor;
  let anchorStart = Infinity;
  const anchored = (x: number): boolean => seen[x] === -gen && !offScreen(x);
  const ends = new Float64Array(4);
  const circle = new Float64Array(3);
  const anchorEnds = (a: number, b: number): void => {
    const aOn = anchored(a);
    const bOn = anchored(b);
    let ra = 0;
    let rb = 0;
    if (aOn) { boundaryCircle(tree, a, anc?.radius, circle); ends[0] = circle[0]!; ends[1] = circle[1]!; ra = circle[2]!; }
    else { ends[0] = tree.cx[a]!; ends[1] = tree.cy[a]!; }
    if (bOn) { boundaryCircle(tree, b, anc?.radius, circle); ends[2] = circle[0]!; ends[3] = circle[1]!; rb = circle[2]!; }
    else { ends[2] = tree.cx[b]!; ends[3] = tree.cy[b]!; }
    const dx = ends[2]! - ends[0]!;
    const dy = ends[3]! - ends[1]!;
    const d = Math.hypot(dx, dy);
    if (!(d > ra + rb)) return; // overlapping circles: centre to centre
    ends[0] = ends[0]! + (dx / d) * ra;
    ends[1] = ends[1]! + (dy / d) * ra;
    ends[2] = ends[2]! - (dx / d) * rb;
    ends[3] = ends[3]! - (dy / d) * rb;
  };

  // Gather drawable directed super-edges + a reciprocal-flow lookup (for both-on-frontier pairs) into
  // the scratch's reused grow-arrays/map (outputs are copied out below — they never alias the scratch).
  const flowByPair = sc.flowByPair;
  flowByPair.clear();
  let len = 0;
  const pushEdge = (a: number, b: number, w: number): void => {
    if (len === sc.aS.length) {
      const cap = len * 2;
      const na = new Int32Array(cap); na.set(sc.aS); sc.aS = na;
      const nb = new Int32Array(cap); nb.set(sc.bS); sc.bS = nb;
      const nw = new Float64Array(cap); nw.set(sc.wS); sc.wS = nw;
    }
    sc.aS[len] = a;
    sc.bS[len] = b;
    sc.wS[len] = w;
    len++;
  };
  for (let i = 0; i < frontier.length; i++) {
    const g = frontier[i]!;
    for (let p = off[g]!; p < off[g + 1]!; p++) {
      const h = tgt[p]!;
      if (seen[h] === gen) {
        // Both present. With cross-level edges on, a lift pair onto an aggregate is summed with the projections
        // below instead (one may land on the same pair, and a pair draws once).
        if (par && merges(g, h)) continue;
        pushEdge(g, h, flw[p]!);
        flowByPair.set(g * tree.size + h, flw[p]!);
        if (dep !== undefined && dep[h] !== dep[g]) claim(g, h, flw[p]!); // a lift pair
      } else if (offScreen(h) && !deeper(h, g)) {
        pushEdge(g, h, flw[p]!);
      }
    }
  }
  // Incoming edges to a present node from an **off-screen source** (the transpose) — so a node keeps its
  // in-edges too, not just out-edges, as a neighbour scrolls off (symmetric with the out-walk above).
  // present sources were already emitted from their out-walk, so only off-screen (non-present) ones here.
  const inOff = tree.superEdgeInOffset;
  const inSrc = tree.superEdgeInSource;
  const inFlw = tree.superEdgeInFlow;
  if (inOff && inSrc && inFlw) {
    for (let i = 0; i < frontier.length; i++) {
      const g = frontier[i]!;
      for (let p = inOff[g]!; p < inOff[g + 1]!; p++) {
        const s = inSrc[p]!;
        if (seen[s] !== gen && offScreen(s) && !deeper(s, g)) {
          pushEdge(s, g, inFlw[p]!);
        }
      }
    }
  }
  const offScreenEnd = len; // the same-level gather's pairs, off-screen ones among them, end here
  // Mixed-level super-edges (#139): the same-level walk skips an off-frontier *on-screen* neighbour (the
  // collapsed↔expanded mismatch). Project it to its nearest present ancestor (`coverOf`) and draw the
  // edge there, deduping per directed pair to sum flow. Iterating from each present node covers both
  // directions: the finer (deeper) present side projects the coarser neighbour *up* to a present ancestor;
  // the coarse side's walk into a finer-expanded region finds only nodes above the finer cover (no present
  // ancestor) or lift pairs deeper than itself (skipped) — so each edge is counted exactly once, pinned
  // over every cut of ragged trees by `super-edges-depth.test.ts` (#325). Gated on `crossLevelEdges` (+ the
  // parent map), so it's ZERO added cost when off (the same-level gather above is untouched).
  if (par) {
    // Nearest present ancestor of `h` (climb parents), or -1 if none — memoised with path-compression so
    // the whole pass stays O(off-frontier-on-screen incidences · depth). Keyed in a Map over only the
    // **touched** nodes: a per-frame `Int32Array(tree.size).fill(-2)` would be an O(all tree nodes)
    // allocation + write every frame, defeating LOD's O(visible) intent (#144 perf section).
    const cover = sc.cover; // node id → nearest present ancestor (-1 = none) — reused, cleared per call
    cover.clear();
    const coverOf = (h: number): number => {
      let x = h;
      while (x >= 0 && !cover.has(x) && seen[x] !== gen) x = par[x]!;
      const c = x < 0 ? -1 : seen[x] === gen ? x : cover.get(x)!;
      for (let y = h; y >= 0 && y !== x; y = par[y]!) cover.set(y, c); // backfill the climbed chain
      return c;
    };
    const proj = sc.proj; // directed pair key (a·size + b) → summed flow — reused, cleared per call
    proj.clear();
    // Out: a present node's out-edge to an off-frontier on-screen target → project the target up (g → c).
    for (let i = 0; i < frontier.length; i++) {
      const g = frontier[i]!;
      for (let p = off[g]!; p < off[g + 1]!; p++) {
        const h = tgt[p]!;
        if (seen[h] === gen) {
          // A present lift pair onto an aggregate (skipped by the same-level walk): summed with projections.
          if (merges(g, h)) {
            const key = g * tree.size + h;
            proj.set(key, (proj.get(key) ?? 0) + flw[p]!);
          }
          continue;
        }
        if (offScreen(h) || deeper(h, g)) continue; // off-screen: emitted above; deeper: projected from its own end
        const c = coverOf(h);
        if (c >= 0 && c !== g) {
          const key = g * tree.size + c;
          proj.set(key, (proj.get(key) ?? 0) + flw[p]!);
        }
      }
    }
    // In: a present node's in-edge from an off-frontier on-screen source → project the source up (c → g).
    if (inOff && inSrc && inFlw) {
      for (let i = 0; i < frontier.length; i++) {
        const g = frontier[i]!;
        for (let p = inOff[g]!; p < inOff[g + 1]!; p++) {
          const s = inSrc[p]!;
          if (seen[s] === gen || offScreen(s) || deeper(s, g)) continue; // present: from its out-walk; off-screen: handled above
          const c = coverOf(s);
          if (c >= 0 && c !== g) {
            const key = c * tree.size + g;
            proj.set(key, (proj.get(key) ?? 0) + inFlw[p]!);
          }
        }
      }
    }
    for (const [key, w] of proj) {
      const a = Math.floor(key / tree.size);
      const b = key - a * tree.size;
      pushEdge(a, b, w);
      flowByPair.set(key, w); // both endpoints present → feed reciprocal half-arrow widths too
      claim(a, b, w);
    }

    // Module links anchored at expanded modules' boundaries (#329). Once a module expands, every pair that
    // carries one of its module links has an expanded end (the module or its ancestors), so neither walk
    // above draws it — and no finer pair exists to project. So walk the own links of each expanded module
    // in view that is not itself present and whose centre is on-screen (an off-screen centre keeps the
    // off-screen rule above): the other end resolves to its present cover, or to itself when it is also
    // anchored or off-screen, and the link is drawn once — a link between two anchored modules from its
    // source's side. Leaf-derived flow never enters these rows (the projection draws it at the children),
    // and an off-screen ancestor's pair that also holds the link gives it up (`claim`), so nothing is
    // counted twice. Expanded-not-present modules are stamped `-gen` in `seen`.
    const mlOff = tree.moduleLinkOffset;
    const mlTgt = tree.moduleLinkTarget;
    const mlFlw = tree.moduleLinkFlow;
    const mlInOff = tree.moduleLinkInOffset;
    const mlInSrc = tree.moduleLinkInSource;
    const mlInFlw = tree.moduleLinkInFlow;
    if (anc && mlOff && mlTgt && mlFlw && mlInOff && mlInSrc && mlInFlw) {
      const expanded = anc.ids;
      for (let i = 0; i < anc.count; i++) {
        const h = expanded[i]!;
        if (seen[h] !== gen) seen[h] = -gen;
      }
      const anchor = sc.anchor;
      anchor.clear();
      const fading = style.fadeAlpha !== undefined;
      // The drawn end of a module link's endpoint x, or -1 when it has none (decluttered / faded out).
      const rep = (x: number): number => {
        const c = coverOf(x);
        if (c >= 0) return c;
        return anchored(x) || offScreen(x) ? x : -1;
      };
      // In a cross-fade band a present module can hold an expanded one; a link to it would point inward.
      const inside = (a: number, h: number): boolean => {
        for (let x = par[h]!; x >= 0; x = par[x]!) if (x === a) return true;
        return false;
      };
      const add = (a: number, b: number, w: number): void => {
        const key = a * tree.size + b;
        anchor.set(key, (anchor.get(key) ?? 0) + w);
      };
      const leaves = tree.leafCount;
      for (let i = 0; i < anc.count; i++) {
        const h = expanded[i]!;
        if (!anchored(h)) continue;
        const o = h - leaves;
        for (let p = mlOff[o]!; p < mlOff[o + 1]!; p++) {
          const b = rep(mlTgt[p]!);
          if (b >= 0 && !(fading && inside(b, h))) add(h, b, mlFlw[p]!);
        }
        for (let p = mlInOff[o]!; p < mlInOff[o + 1]!; p++) {
          const a = rep(mlInSrc[p]!);
          // An anchored source draws the link from its own out-row.
          if (a >= 0 && !anchored(a) && !(fading && inside(a, h))) add(a, h, mlInFlw[p]!);
        }
      }
      anchorStart = len;
      for (const [key, w] of anchor) {
        const a = Math.floor(key / tree.size);
        const b = key - a * tree.size;
        pushEdge(a, b, w);
        flowByPair.set(key, w); // reciprocal anchored links (A→B and B→A) share their widths
        claim(a, b, w);
      }
    }
  }
  // The claims (see `claim`): each off-screen pair of the same-level gather that finer drawn pairs share
  // flow with keeps the rest, or is dropped when nothing is left (float32 sums: within 1e-4 of its flow).
  if (claimed.size > 0) {
    let kept = 0;
    for (let e = 0; e < len; e++) {
      const a = sc.aS[e]!;
      const b = sc.bS[e]!;
      let w = sc.wS[e]!;
      const x = seen[a] === gen ? b : a; // an off-screen pair's non-present end
      if (e < offScreenEnd && seen[x] !== gen && claimedEnds.has(x)) {
        const c = claimed.get(a * tree.size + b);
        if (c !== undefined) {
          const rest = w - c;
          if (!(rest > w * 1e-4)) continue;
          w = rest;
        }
      }
      sc.aS[kept] = a;
      sc.bS[kept] = b;
      sc.wS[kept] = w;
      kept++;
    }
    if (anchorStart !== Infinity) anchorStart -= len - kept; // only same-level pairs (before it) are dropped
    len = kept;
  }
  const count = len;
  const aS = sc.aS;
  const bS = sc.bS;
  const wS = sc.wS;
  // Summed flow per edge, COPIED out of the scratch — callers keep `flows` past this call (e.g. the
  // link-pick resolve closure), so the output must not alias the reused gather array.
  const flows: number[] = new Array<number>(count);
  for (let e = 0; e < count; e++) flows[e] = wS[e]!;
  // Stable per-super-edge id (the directed tree-node pair), parallel to `count`. The Scene path (#138)
  // keys its link drawables by it so the retained-scene diff is stable across re-cuts; the WebGL lane
  // ignores it. Half-arrows and lines/arrows share the one edge order, so one id array serves both.
  const ids: number[] = new Array(count);
  for (let e = 0; e < count; e++) ids[e] = aS[e]! * tree.size + bS[e]!;
  const maxAgg = style.maxAggregateRadius ?? Infinity;
  const drawnRadius = (g: number): number => (g < tree.leafCount ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg));

  // Endpoints (centroids) + per-edge colour are common to both styles.
  const sources = new Float32Array(count * 2);
  const targets = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 4);
  // Cross-fade (#133): scale an edge's alpha by its least-visible present endpoint (off-screen endpoints
  // are opaque), so it fades with the aggregate/child it connects. `fa` undefined ⇒ full opacity.
  const fa = style.fadeAlpha;
  for (let e = 0; e < count; e++) {
    const g = aS[e]!;
    const h = bS[e]!;
    const anchoredEdge = e >= anchorStart;
    if (anchoredEdge) {
      anchorEnds(g, h);
      sources[e * 2] = ends[0]!;
      sources[e * 2 + 1] = ends[1]!;
      targets[e * 2] = ends[2]!;
      targets[e * 2 + 1] = ends[3]!;
    } else {
      sources[e * 2] = tree.cx[g]!;
      sources[e * 2 + 1] = tree.cy[g]!;
      targets[e * 2] = tree.cx[h]!;
      targets[e * 2 + 1] = tree.cy[h]!;
    }
    const [cr, cg, cb, ca] = style.colorOf(wS[e]!);
    colors[e * 4] = cr;
    colors[e * 4 + 1] = cg;
    colors[e * 4 + 2] = cb;
    if (fa) {
      // An anchored boundary end fades with its module's children (the cut wrote their alpha for it).
      const af = seen[g] === gen || (anchoredEdge && seen[g] === -gen) ? fa[g]! : 1;
      const bf = seen[h] === gen || (anchoredEdge && seen[h] === -gen) ? fa[h]! : 1;
      colors[e * 4 + 3] = Math.round(ca * Math.min(af, bf));
    } else {
      colors[e * 4 + 3] = ca;
    }
  }
  // Draw radius of edge e's end x: a boundary end already sits on its circle (0), else the glyph radius.
  const endRadius = (e: number, x: number): number => (e >= anchorStart && anchored(x) ? 0 : drawnRadius(x));

  if (style.linkStyle === "half-arrow" && style.directed) {
    const radii = new Float32Array(count * 2);
    const widths = new Float32Array(count * 2);
    const bends = new Float32Array(count).fill(style.bend);
    for (let e = 0; e < count; e++) {
      radii[e * 2] = endRadius(e, aS[e]!);
      radii[e * 2 + 1] = endRadius(e, bS[e]!);
      const w = style.widthOf(wS[e]!);
      const opp = flowByPair.get(bS[e]! * tree.size + aS[e]!);
      widths[e * 2] = w;
      widths[e * 2 + 1] = opp === undefined ? w : style.widthOf(opp);
    }
    return { halfArrows: { sources, targets, radii, widths, bends, colors, count }, ids, flows };
  }

  // Line style: bent/straight lines ∝ flow; directed → arrowheads set back to the target's (capped)
  // boundary along the bent end-tangent. Same colour as the line.
  const widths = new Float32Array(count);
  for (let e = 0; e < count; e++) widths[e] = style.widthOf(wS[e]!);
  const bends = new Float32Array(count).fill(style.bend);
  const lines: InstancedLinesData = style.bend
    ? { sources, targets, widths, colors, bends, samples: BENT_SAMPLES, count }
    : { sources, targets, widths, colors, count };
  if (!style.directed) return { lines, ids, flows };

  // Arrowheads orient + set back in-shader (so screen sizeMode is honoured): pass the target centre
  // (already in `targets`) plus its draw radius; the shader puts the tip on the node boundary. A
  // one-sided **half** head only for bent links (so reciprocal heads don't collide); straight links
  // get the symmetric triangle — matching the non-LOD path (`half: bend !== 0`).
  const aRadii = new Float32Array(count);
  for (let e = 0; e < count; e++) aRadii[e] = endRadius(e, bS[e]!);
  const arrows: InstancedArrowsData = { sources, targets, radii: aRadii, sizes: new Float32Array(count).fill(style.arrowSize), colors, bends, half: style.bend !== 0, count };
  return { lines, arrows, ids, flows };
}

/** The first element-wise difference between two gather outputs (`Object.is`, so −0 and NaN count), or ""
 *  when they are identical: ids, flows, and every array and scalar of each link-style batch. */
export function firstDifference(a: SuperEdgesData, b: SuperEdgesData): string {
  const arr = (name: string, x: ArrayLike<number> | undefined, y: ArrayLike<number> | undefined): string => {
    if (x === undefined || y === undefined) return x === y ? "" : `${name}: present on one side only`;
    if (x.length !== y.length) return `${name}: length ${x.length} vs ${y.length}`;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return `${name}[${i}]: ${x[i]} vs ${y[i]}`;
    return "";
  };
  const scalar = (name: string, x: number | boolean | undefined, y: number | boolean | undefined): string => (Object.is(x, y) ? "" : `${name}: ${x} vs ${y}`);
  const parts = [arr("ids", a.ids, b.ids), arr("flows", a.flows, b.flows), scalar("halfArrows", !!a.halfArrows, !!b.halfArrows), scalar("lines", !!a.lines, !!b.lines), scalar("arrows", !!a.arrows, !!b.arrows)];
  const h = a.halfArrows;
  const hb = b.halfArrows;
  if (h && hb) {
    parts.push(arr("halfArrows.sources", h.sources, hb.sources), arr("halfArrows.targets", h.targets, hb.targets), arr("halfArrows.radii", h.radii, hb.radii));
    parts.push(arr("halfArrows.widths", h.widths, hb.widths), arr("halfArrows.bends", h.bends, hb.bends), arr("halfArrows.colors", h.colors, hb.colors), scalar("halfArrows.count", h.count, hb.count));
  }
  const l = a.lines;
  const lb = b.lines;
  if (l && lb) {
    parts.push(arr("lines.sources", l.sources, lb.sources), arr("lines.targets", l.targets, lb.targets), arr("lines.widths", l.widths, lb.widths));
    parts.push(arr("lines.colors", l.colors, lb.colors), arr("lines.bends", l.bends, lb.bends), scalar("lines.samples", l.samples, lb.samples), scalar("lines.count", l.count, lb.count));
  }
  const ar = a.arrows;
  const arb = b.arrows;
  if (ar && arb) {
    parts.push(arr("arrows.sources", ar.sources, arb.sources), arr("arrows.targets", ar.targets, arb.targets), arr("arrows.radii", ar.radii, arb.radii), arr("arrows.sizes", ar.sizes, arb.sizes));
    parts.push(arr("arrows.colors", ar.colors, arb.colors), arr("arrows.bends", ar.bends, arb.bends), scalar("arrows.half", ar.half, arb.half), scalar("arrows.count", ar.count, arb.count));
  }
  return parts.filter((p) => p !== "").join("; ");
}
