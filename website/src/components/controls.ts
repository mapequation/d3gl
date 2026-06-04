// website/src/components/controls.ts

/** A labelled segmented button group. Calls onChange(value) on click; marks the active button. */
export function segmented(
  label: string,
  options: string[],
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "d3gl-seg flex items-center gap-1.5";
  if (label) {
    const l = document.createElement("span");
    l.className = "d3gl-seg-label text-[var(--sl-color-gray-3)]";
    l.textContent = label;
    wrap.appendChild(l);
  }
  const group = document.createElement("div");
  group.className =
    "d3gl-seg-group inline-flex items-center overflow-hidden rounded-md border border-[var(--sl-color-gray-4)]";
  // Active-state styling is driven by the `.is-active` hook via compound-selector
  // utilities (`[&.is-active]:…`), which out-specify the base background utility so
  // the runtime only has to toggle the single `is-active` class (as the tests expect).
  const btnBase =
    "box-border inline-flex items-center px-2.5 py-1 text-[13px] leading-none cursor-pointer border-0 " +
    "bg-[var(--sl-color-gray-6)] text-[var(--sl-color-text)] " +
    "hover:bg-[var(--sl-color-gray-5)] " +
    "[&.is-active]:bg-[var(--sl-color-accent)] [&.is-active]:text-white [&.is-active]:cursor-default " +
    "[&:not(:first-child)]:border-l [&:not(:first-child)]:border-[var(--sl-color-gray-4)]";
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = btnBase;
    b.textContent = opt;
    if (opt === value) b.classList.add("is-active");
    b.addEventListener("click", () => {
      if (b.classList.contains("is-active")) return;
      group.querySelectorAll("button").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      onChange(opt);
    });
    group.appendChild(b);
  }
  wrap.appendChild(group);
  return wrap;
}

/**
 * A labelled range slider. Updates its label live on `input` but only emits the chosen value
 * on `change` (pointer release) — so regenerating heavy geometry doesn't thrash while dragging.
 */
export function slider(
  label: string,
  spec: { min: number; max: number; step: number; value: number; display?: string[] },
  onChange: (value: number) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "d3gl-seg flex items-center gap-1.5";
  const l = document.createElement("span");
  l.className = "d3gl-seg-label text-[var(--sl-color-gray-3)]";
  const fmt = (v: number): string => spec.display?.[(v - spec.min) / spec.step] ?? String(v);
  l.textContent = `${label} ${fmt(spec.value)}`;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);
  input.className = "d3gl-range";
  input.style.accentColor = "var(--sl-color-accent)";
  input.addEventListener("input", () => { l.textContent = `${label} ${fmt(Number(input.value))}`; });
  input.addEventListener("change", () => onChange(Number(input.value)));
  wrap.append(l, input);
  return wrap;
}

/** A single action button (e.g. Export). `getLabel()` lets the caller relabel it dynamically. */
export function actionButton(getLabel: () => string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "d3gl-action box-border inline-flex items-center rounded-md border border-[var(--sl-color-gray-4)] bg-[var(--sl-color-gray-6)] px-2.5 py-1 text-[13px] leading-none text-[var(--sl-color-text)] cursor-pointer hover:bg-[var(--sl-color-gray-5)]";
  b.textContent = getLabel();
  b.addEventListener("click", onClick);
  (b as any).refresh = () => { b.textContent = getLabel(); };
  return b;
}

/** Trigger a browser download of a data URL or string payload. */
export function download(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
}
