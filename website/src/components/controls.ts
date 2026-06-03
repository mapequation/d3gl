// website/src/components/controls.ts

/** A labelled segmented button group. Calls onChange(value) on click; marks the active button. */
export function segmented(
  label: string,
  options: string[],
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "d3gl-seg";
  if (label) {
    const l = document.createElement("span");
    l.className = "d3gl-seg-label";
    l.textContent = label;
    wrap.appendChild(l);
  }
  const group = document.createElement("div");
  group.className = "d3gl-seg-group";
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
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
  wrap.className = "d3gl-seg";
  const l = document.createElement("span");
  l.className = "d3gl-seg-label";
  const fmt = (v: number): string => spec.display?.[(v - spec.min) / spec.step] ?? String(v);
  l.textContent = `${label} ${fmt(spec.value)}`;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);
  input.className = "d3gl-range";
  input.addEventListener("input", () => { l.textContent = `${label} ${fmt(Number(input.value))}`; });
  input.addEventListener("change", () => onChange(Number(input.value)));
  wrap.append(l, input);
  return wrap;
}

/** A single action button (e.g. Export). `getLabel()` lets the caller relabel it dynamically. */
export function actionButton(getLabel: () => string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "d3gl-action";
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
