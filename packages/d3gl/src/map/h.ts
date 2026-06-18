/**
 * A minimal hyperscript helper: build a detached DOM element tree declaratively,
 * with no framework and no HTML-string parsing. It's the un-sugared
 * `React.createElement` model — handy for the rich content the engine `tooltip`
 * option accepts (`(d) => HTMLElement`), or any HTML overlay.
 *
 * Props are applied as plain attributes via `setAttribute` (so `class` and
 * `style` are just `"class"` / `"style"` strings); `null`/`undefined` values are
 * skipped. Children may be a string, number, `Node`, or a (nested) array thereof;
 * nullish children are skipped and primitives become text nodes — so values are
 * always inserted as text, never parsed as markup.
 *
 * ```ts
 * import { h } from "@mapequation/d3gl/map";
 *
 * tooltip: (d) => h("div", null, [
 *   h("div", { class: "font-semibold" }, d.name),
 *   h("table", null, d.rows.map((r) =>
 *     h("tr", null, [h("td", null, r.key), h("td", { class: "text-right" }, r.value)]))),
 * ]);
 * ```
 */
export type HChild = string | number | Node | null | undefined | HChild[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, string | number | null | undefined> | null,
  children?: HChild,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value != null) el.setAttribute(key, String(value));
    }
  }
  appendChild(el, children);
  return el;
}

/** Append a child (recursing into arrays); primitives become text nodes. */
function appendChild(el: HTMLElement, child: HChild): void {
  if (child == null) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(el, c);
    return;
  }
  el.append(child instanceof Node ? child : document.createTextNode(String(child)));
}
