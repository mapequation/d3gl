import type { ViewTransform } from "../webgl/index.js";
import { cullLabels, labelCullScratch, labelTransform } from "./cull.js";
import type { LabelBaseline, LabelBox, LabelCullScratch, TextAnchor } from "./cull.js";

/** A label anchored in REFERENCE (projected, pre-transform) pixel space. */
export interface LabelAnchor {
  id: string | number;
  refX: number;
  refY: number;
  text: string;
  width?: number;
  height?: number;
  priority?: number;
  /**
   * A constant screen-pixel offset [dx, dy] from the projected anchor, applied to BOTH the
   * rendered position and the collision box — so it stays a fixed distance from the node at
   * any zoom, and culling reflects where the label actually sits (no overlap as you zoom in).
   */
  offset?: [number, number];
  /**
   * Reading-direction angle in radians. Setting it switches the label to the ORIENTED model:
   * the library derives BOTH the rendered CSS transform and the collision box from this single
   * angle (with {@link textAnchor}/{@link keepUpright}), so they cannot drift apart. Leave it
   * undefined for a plain axis-aligned label and supply your own {@link transform}.
   */
  rotation?: number;
  /** Which way the text runs from the anchor (default "start"). Honoured by plain labels too, so a
   *  centred label collides on the box it renders in — the library derives its CSS transform (#204). */
  textAnchor?: TextAnchor;
  /** Plain labels: vertical placement of the box relative to the anchor (default "top"). */
  baseline?: LabelBaseline;
  /** Oriented labels only: flip 180° to keep the text upright (radial-tree readability flip). */
  keepUpright?: boolean;
  /** Optional CSS transform for a PLAIN label with no declared `textAnchor`/`baseline` (the library
   *  generates the transform whenever the box's placement is declared). Use `offset` for a
   *  constant-px gap. */
  transform?: string;
  /** transform-origin for the node; defaults to "0 0" (the anchor point). */
  transformOrigin?: string;
  /** Per-label opacity [0,1] (default 1). Lets a caller cross-fade labels in/out in lockstep with the
   *  glyphs they sit on — e.g. the network LOD cross-fade (#133) fading a module ↔ its sub-modules. */
  opacity?: number;
}

/** Project one anchor to its screen {@link LabelBox} (`screen = k·ref + (x,y)` + the constant offset). */
export function anchorBox(a: LabelAnchor, transform: ViewTransform): LabelBox {
  return {
    id: a.id,
    x: transform.k * a.refX + transform.x + (a.offset?.[0] ?? 0),
    y: transform.k * a.refY + transform.y + (a.offset?.[1] ?? 0),
    width: a.width,
    height: a.height,
    priority: a.priority,
    text: a.text,
    opacity: a.opacity,
    rotation: a.rotation,
    textAnchor: a.textAnchor,
    baseline: a.baseline,
    keepUpright: a.keepUpright,
    transform: a.transform,
    transformOrigin: a.transformOrigin,
  };
}

/**
 * Project label anchors to screen px (`screen = k·ref + (x,y)` + the constant offset) and resolve
 * collisions, returning the survivors as {@link LabelBox}es (carrying `text`/`opacity`). Shared by the
 * HTML overlay ({@link LabelLayer.update}) and the backend-native text path (#105 N7b-2) so both place
 * and cull labels identically — they differ only in how they render the survivors.
 */
export function placeLabels(
  anchors: readonly LabelAnchor[],
  transform: ViewTransform,
  viewport: { width: number; height: number },
  /** Reusable cull buffers — pass the caller's retained one on the per-frame path (#204). */
  scratch?: LabelCullScratch,
): LabelBox[] {
  const boxes: LabelBox[] = anchors.map((a) => anchorBox(a, transform));
  return cullLabels(boxes, { viewport, scratch });
}

/**
 * Inline CSS for overlay label elements: camelCased CSS property → value (the string-valued
 * subset of `CSSStyleDeclaration`), e.g. `{ color: "#1f2937", textShadow: "0 0 2px #fff" }`.
 * A plain, engine-agnostic shape, so it can lift as-is into other engines' label overlays (#223).
 */
export type LabelStyle = {
  [P in Extract<keyof CSSStyleDeclaration, string> as CSSStyleDeclaration[P] extends string ? P : never]?: string;
};

/**
 * A legibility halo (#571): a `color` stroke reaching `width` px beyond the glyph outlines, painted
 * behind the fill. One shape for every backend — the HTML overlay (a CSS text stroke, {@link haloStyle}),
 * Canvas `strokeText` and SVG `<text>`, exports included — so they draw the same halo. `width` 0 draws none.
 */
export type LabelHalo = { color: string; width: number };

/**
 * Default overlay label look (#224) — a compact dark sans-serif label, readable over busy geometry
 * with zero user CSS. Its white halo is not here: {@link resolveLabelStyle} adds it from the label
 * set's {@link LabelHalo}, so the overlay strokes the same halo as Canvas/SVG (#571). Applied by the
 * engine label APIs (e.g. `network.labels()`); a raw {@link LabelLayer} stays unstyled by default (the
 * low-level primitive keeps today's inherit-from-container behaviour).
 */
export const DEFAULT_LABEL_STYLE: LabelStyle = {
  font: "600 11px/1 system-ui, sans-serif",
  color: "#111827",
};

/**
 * The overlay CSS for a {@link LabelHalo} (#571): a text stroke twice the halo width, painted under
 * the fill (`paint-order`), so it reaches `width` px beyond the glyphs with round joins — as the
 * Canvas/SVG stroke does. Empty for no halo (`null`/`undefined`) or width 0.
 */
export function haloStyle(halo: LabelHalo | null | undefined): LabelStyle {
  if (!halo || halo.width <= 0) return {};
  return { webkitTextStroke: `${halo.width * 2}px ${halo.color}`, paintOrder: "stroke", strokeLinejoin: "round" };
}

/**
 * The engine-label styling policy (#224): {@link DEFAULT_LABEL_STYLE}, then the `halo`'s stroke
 * ({@link haloStyle}; the default white halo when omitted, `null` for none), then a caller's inline
 * {@link LabelStyle} — a partial override keeps the rest —
 * but when a `className` is given, return only the explicit `style` (possibly undefined): the class's
 * CSS keeps full control, since an inline default would beat it. Shared so other engines lift the
 * exact same policy (#223); pass the result as {@link LabelLayer}'s `style`.
 */
export function resolveLabelStyle(className: string | undefined, style: LabelStyle | undefined, halo: LabelHalo | null = DEFAULT_LABEL_TEXT.halo): LabelStyle | undefined {
  return className ? style : { ...DEFAULT_LABEL_STYLE, ...haloStyle(halo), ...style };
}

/**
 * The same default look for BACKEND-NATIVE text (SVG `<text>` / Canvas `fillText`, incl. export),
 * which CSS can't reach: the `font`/`color` equivalent of {@link DEFAULT_LABEL_STYLE} (canvas font
 * shorthand takes no line-height), and the default halo every backend strokes (#571).
 */
export const DEFAULT_LABEL_TEXT: { font: string; color: string; halo: LabelHalo } = {
  font: "600 11px system-ui, sans-serif",
  color: "#111827",
  halo: { color: "#ffffff", width: 1 },
};

/**
 * The halo a label set draws (#571): the explicit `halo`, else none when `style.textShadow` is
 * `"none"` (the opt-out from when the overlay's halo was a text-shadow), else {@link DEFAULT_LABEL_TEXT}'s.
 */
export function resolveLabelHalo(halo: LabelHalo | undefined, style: LabelStyle | undefined): LabelHalo | undefined {
  return halo ?? (style?.textShadow === "none" ? undefined : DEFAULT_LABEL_TEXT.halo);
}

/**
 * An HTML overlay of absolutely-positioned label elements. On each update it maps
 * reference anchors through the view transform to screen pixels, culls to the
 * viewport with collision resolution, and reconciles the DOM (reusing nodes by
 * id). Geometry stays on the GPU; only the surviving labels are in the DOM.
 *
 * The container should be positioned (e.g. `position: relative`) and overlay the
 * canvas; label nodes are `position: absolute`.
 */
export class LabelLayer {
  private nodes = new Map<string, HTMLDivElement>();
  /** Retained cull buffers — `update` runs on every transform, so the placement pass reuses them
   *  instead of allocating a grid + per-candidate geometry per frame (#204). */
  private readonly cullScratch = labelCullScratch();

  constructor(
    private readonly container: HTMLElement,
    private readonly text: (anchor: LabelAnchor) => string,
    /** Optional class set on each label element, for styling the overlay (font, colour, halo). */
    private readonly className?: string,
    /** Optional inline CSS set on each label element, applied ONCE at creation — never on the
     *  per-transform update path. Applied as given: engine callers pass the default-merged result
     *  of {@link resolveLabelStyle}; omitted, elements inherit from the container as before. */
    private readonly style?: LabelStyle,
  ) {}

  /** The label shown in full while hovered (#496), and the text its placed node returns to afterwards. */
  private hover: { anchor: LabelAnchor; restore: string } | null = null;
  /** Key of a node that exists only for {@link hover} (its label was not placed), else null. */
  private hoverOnly: string | null = null;

  private makeNode(key: string): HTMLDivElement {
    const node = document.createElement("div");
    node.dataset.labelId = key;
    node.style.position = "absolute";
    node.style.pointerEvents = "none";
    node.style.whiteSpace = "nowrap";
    if (this.className) node.className = this.className;
    // Styling lands ONCE here, in the creation branch — reused elements are never restyled on
    // the per-transform update path (only left/top/transform/opacity below are per-update).
    if (this.style) Object.assign(node.style, this.style);
    this.container.appendChild(node);
    this.nodes.set(key, node);
    return node;
  }

  /** Write one box's text and placement to its node. */
  private paint(node: HTMLDivElement, box: LabelBox, text: string): void {
    node.textContent = this.text({ id: box.id, refX: 0, refY: 0, text });
    node.style.left = `${Math.round(box.x)}px`;
    node.style.top = `${Math.round(box.y)}px`;
    // The library generates the transform from the same box used for collision (so render and
    // culling agree) whenever the placement is declared — rotation, or textAnchor/baseline. A
    // plain top-left label declares none, so `labelTransform` returns "" and the caller's own
    // transform applies.
    const derived = labelTransform(box);
    node.style.transform = derived || ((box.transform as string) ?? "");
    node.style.transformOrigin = (box.transformOrigin as string) ?? "0 0";
    const op = box.opacity as number | undefined;
    node.style.opacity = op == null ? "" : String(op);
  }

  update(
    anchors: readonly LabelAnchor[],
    transform: ViewTransform,
    viewport: { width: number; height: number },
  ): void {
    // Project + cull (shared with the backend-native text path), then render the survivors to DOM.
    const visible = placeLabels(anchors, transform, viewport, this.cullScratch);
    const seen = new Set<string>();
    const hover = this.hover;
    const hoverKey = hover ? String(hover.anchor.id) : null;

    for (const box of visible) {
      const key = String(box.id);
      seen.add(key);
      const node = this.nodes.get(key) ?? this.makeNode(key);
      if (key === hoverKey && hover) { this.paint(node, box, hover.anchor.text); node.style.zIndex = "1"; }
      else this.paint(node, box, String(box.text));
    }
    // The hovered label is shown even when collision culling dropped its trimmed twin: one extra node.
    this.hoverOnly = null;
    if (hover && hoverKey !== null && !seen.has(hoverKey)) {
      seen.add(hoverKey);
      this.showHoverOnly(hoverKey, hover.anchor, transform);
    }

    for (const [key, node] of this.nodes) {
      if (!seen.has(key)) {
        node.remove();
        this.nodes.delete(key);
      }
    }
  }

  private showHoverOnly(key: string, anchor: LabelAnchor, transform: ViewTransform): void {
    const node = this.nodes.get(key) ?? this.makeNode(key);
    this.paint(node, anchorBox(anchor, transform), anchor.text);
    node.style.zIndex = "1";
    this.hoverOnly = key;
  }

  /**
   * Show `anchor`'s text (the label in full) in place of its trimmed twin while hovered (#496), or
   * clear it (`null`). `restore` is the text the label returns to on the next call. O(1): one node
   * lookup (a new node is made only when the label was not placed), no placement pass, so a hover
   * sweep costs the same per pointer move whatever number of labels is placed. The stored anchor also
   * applies on every later {@link update}.
   */
  setHover(anchor: LabelAnchor | null, restore: string, transform: ViewTransform): void {
    const prev = this.hover;
    if (prev) {
      const key = String(prev.anchor.id);
      const node = this.nodes.get(key);
      if (node) {
        if (this.hoverOnly === key) { node.remove(); this.nodes.delete(key); }
        else { node.textContent = prev.restore; node.style.zIndex = ""; }
      }
      this.hoverOnly = null;
    }
    this.hover = anchor ? { anchor, restore } : null;
    if (!anchor) return;
    const key = String(anchor.id);
    const node = this.nodes.get(key);
    if (node) { node.textContent = anchor.text; node.style.zIndex = "1"; }
    else this.showHoverOnly(key, anchor, transform);
  }

  destroy(): void {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.hover = null;
    this.hoverOnly = null;
  }
}
