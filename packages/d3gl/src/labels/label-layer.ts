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
    // reference -> screen: screen = k*ref + (x,y), plus the constant-px offset.
    const boxes: LabelBox[] = anchors.map((a) => ({
      id: a.id,
      x: transform.k * a.refX + transform.x + (a.offset?.[0] ?? 0),
      y: transform.k * a.refY + transform.y + (a.offset?.[1] ?? 0),
      width: a.width,
      height: a.height,
      priority: a.priority,
      text: a.text,
      rotation: a.rotation,
      textAnchor: a.textAnchor,
      keepUpright: a.keepUpright,
      transform: a.transform,
      transformOrigin: a.transformOrigin,
    }));
    const visible = cullLabels(boxes, { viewport });
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
