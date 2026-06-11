/** A single shared, absolutely-positioned, pointer-events-none tooltip div in the
 *  host. Created lazily on first show; default inline look unless a className is
 *  given (then styling is entirely the caller's). Always carries `d3gl-tooltip`. */
export class Tooltip {
  private el: HTMLDivElement | null = null;
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
  }

  /** Position near host-relative (x, y) with a 12px offset, clamped into the host. */
  move(x: number, y: number, hostW: number, hostH: number): void {
    if (!this.el || this.el.style.display === "none") return;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    this.el.style.left = `${Math.max(0, Math.min(x + 12, hostW - w))}px`;
    this.el.style.top = `${Math.max(0, Math.min(y + 12, hostH - h))}px`;
  }

  hide(): void { if (this.el) this.el.style.display = "none"; }
  destroy(): void { this.el?.remove(); this.el = null; }
}
