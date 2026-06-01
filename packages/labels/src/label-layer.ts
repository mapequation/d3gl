import type { ViewTransform } from "@d3gl/webgl";
import { cullLabels } from "./cull.js";
import type { LabelBox } from "./cull.js";

/** A label anchored in REFERENCE (projected, pre-transform) pixel space. */
export interface LabelAnchor {
  id: string | number;
  refX: number;
  refY: number;
  text: string;
  width?: number;
  height?: number;
  priority?: number;
  /** Optional CSS transform applied at the anchor point (origin = the anchor). The
   *  consumer owns layout-specific placement (gap offset, radial rotation, etc.). */
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
  ) {}

  update(
    anchors: readonly LabelAnchor[],
    transform: ViewTransform,
    viewport: { width: number; height: number },
  ): void {
    // reference -> screen: screen = k*ref + (x,y)
    const boxes: LabelBox[] = anchors.map((a) => ({
      id: a.id,
      x: transform.k * a.refX + transform.x,
      y: transform.k * a.refY + transform.y,
      width: a.width,
      height: a.height,
      priority: a.priority,
      text: a.text,
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
      node.style.transform = (box.transform as string) ?? "";
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
