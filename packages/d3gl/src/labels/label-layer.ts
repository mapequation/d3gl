import type { ViewTransform } from "../webgl/index.js";
import { cullLabels, labelGeometry } from "./cull.js";
import type { LabelBox, TextAnchor } from "./cull.js";

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
  /** Oriented labels only: which way the text runs from the anchor (default "start"). */
  textAnchor?: TextAnchor;
  /** Oriented labels only: flip 180° to keep the text upright (radial-tree readability flip). */
  keepUpright?: boolean;
  /** Optional CSS transform for a PLAIN label (ignored when `rotation` is set, since the
   *  library then generates the transform). Use `offset` for the constant-px gap. */
  transform?: string;
  /** transform-origin for the node; defaults to "0 0" (the anchor point). */
  transformOrigin?: string;
  /** Per-label opacity [0,1] (default 1). Lets a caller cross-fade labels in/out in lockstep with the
   *  glyphs they sit on — e.g. the network LOD cross-fade (#133) fading a module ↔ its sub-modules. */
  opacity?: number;
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
): LabelBox[] {
  const boxes: LabelBox[] = anchors.map((a) => ({
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
    keepUpright: a.keepUpright,
    transform: a.transform,
    transformOrigin: a.transformOrigin,
  }));
  return cullLabels(boxes, { viewport });
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

  constructor(
    private readonly container: HTMLElement,
    private readonly text: (anchor: LabelAnchor) => string,
    /** Optional class set on each label element, for styling the overlay (font, colour, halo). */
    private readonly className?: string,
  ) {}

  update(
    anchors: readonly LabelAnchor[],
    transform: ViewTransform,
    viewport: { width: number; height: number },
  ): void {
    // Project + cull (shared with the backend-native text path), then render the survivors to DOM.
    const visible = placeLabels(anchors, transform, viewport);
    const seen = new Set<string>();

    for (const box of visible) {
      const key = String(box.id);
      seen.add(key);
      let node = this.nodes.get(key);
      if (!node) {
        node = document.createElement("div");
        node.dataset.labelId = key;
        node.style.position = "absolute";
        node.style.pointerEvents = "none";
        node.style.whiteSpace = "nowrap";
        if (this.className) node.className = this.className;
        this.container.appendChild(node);
        this.nodes.set(key, node);
      }
      node.textContent = this.text({
        id: box.id,
        refX: 0,
        refY: 0,
        text: String(box.text),
      });
      node.style.left = `${Math.round(box.x)}px`;
      node.style.top = `${Math.round(box.y)}px`;
      // Oriented labels: the library generates the transform from the same geometry used for
      // collision (so render and culling agree). Plain labels keep the caller's transform.
      node.style.transform =
        box.rotation !== undefined ? labelGeometry(box).transform : ((box.transform as string) ?? "");
      node.style.transformOrigin = (box.transformOrigin as string) ?? "0 0";
      const op = box.opacity as number | undefined;
      node.style.opacity = op == null ? "" : String(op);
    }

    for (const [key, node] of this.nodes) {
      if (!seen.has(key)) {
        node.remove();
        this.nodes.delete(key);
      }
    }
  }

  destroy(): void {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
  }
}
