/** A single shared, absolutely-positioned, pointer-events-none tooltip div in the
 *  host. Created lazily on first show; default inline look unless a className is
 *  given (then styling is entirely the caller's). Always carries `d3gl-tooltip`. */
export class Tooltip {
  private el: HTMLDivElement | null = null;
  /** Cached box dimensions — measured once in show() after content + display:block are
   *  set (forced reflow there is unavoidable) so move() on every pointermove can use
   *  them without touching offsetWidth/Height again and triggering a second reflow.
   *  Reset to 0 when hidden so a stale size never persists across content changes. */
  private w = 0;
  private h = 0;
  constructor(private readonly host: HTMLElement, private readonly className?: string) {}

  private ensure(): HTMLDivElement {
    if (this.el) return this.el;
    const el = document.createElement("div");
    el.className = this.className ? `d3gl-tooltip ${this.className}` : "d3gl-tooltip";
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.display = "none";
    el.style.zIndex = "10";
    if (!this.className) {
      el.style.background = "rgba(255, 255, 255, 0.95)";
      el.style.border = "1px solid #ccc";
      el.style.borderRadius = "3px";
      el.style.padding = "2px 6px";
      el.style.font = "12px system-ui, sans-serif";
      el.style.color = "#222";
    }
    this.host.appendChild(el);
    this.el = el;
    return el;
  }

  show(content: string | HTMLElement): void {
    const el = this.ensure();
    if (typeof content === "string") el.textContent = content;
    else el.replaceChildren(content);
    el.style.display = "block";
    // Measure now, while the reflow is already dirty from the display write above.
    // Dimensions only change with content, not with pointer position, so caching here
    // lets move() skip offsetWidth/Height on every pointermove (per-move reflow avoidance).
    this.w = el.offsetWidth;
    this.h = el.offsetHeight;
  }

  /** Position near host-relative (x, y) with a 12px offset, clamped into the host.
   *  Reads host.clientWidth/clientHeight so the clamp tracks the CSS size correctly
   *  under responsive layouts where the host may differ from the engine's logical size. */
  move(x: number, y: number): void {
    if (!this.el || this.el.style.display === "none") return;
    const hostW = this.host.clientWidth;
    const hostH = this.host.clientHeight;
    // Fall back to unclamped position when the host is detached (clientWidth/Height = 0).
    const left = hostW > 0 ? Math.max(0, Math.min(x + 12, hostW - this.w)) : x + 12;
    const top  = hostH > 0 ? Math.max(0, Math.min(y + 12, hostH - this.h)) : y + 12;
    this.el.style.left = `${left}px`;
    this.el.style.top  = `${top}px`;
  }

  hide(): void {
    if (this.el) { this.el.style.display = "none"; this.w = 0; this.h = 0; }
  }
  destroy(): void { this.el?.remove(); this.el = null; }
}
