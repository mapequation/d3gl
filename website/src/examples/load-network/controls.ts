/**
 * Overlay control bar for the load-network example: a file picker + two built-in-sample buttons.
 * Plain DOM plumbing, kept out of the example's d3gl `draw.ts` so the code tab stays focused.
 */
import { SAMPLE_PAJEK, SAMPLE_EDGELIST } from "./data.js";

const BTN =
  "rounded border border-[#cbd5e1] bg-white/90 px-2 py-1 text-xs text-[#334] shadow-sm hover:bg-white cursor-pointer";

/**
 * Build the control bar; `load(text, filename)` is called with whatever the user picks/clicks. A file
 * the parser refuses (it throws, naming the line) shows its message in the bar.
 */
export function makeControls(load: (text: string, filename: string) => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "absolute left-2 top-2 z-10 flex flex-wrap items-center gap-2";

  const error = document.createElement("span");
  error.className = "max-w-md rounded bg-white/90 px-2 py-1 text-xs text-[#b91c1c] empty:hidden";
  error.setAttribute("role", "alert");
  const tryLoad = (text: string, filename: string): void => {
    error.textContent = "";
    try {
      load(text, filename);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  };

  const picker = document.createElement("label");
  picker.className = BTN;
  picker.textContent = "Load .net / edge list…";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".net,.txt,.edges,.edgelist,.tsv,.csv,text/plain";
  input.className = "hidden";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((text) => tryLoad(text, file.name));
    input.value = ""; // let the same file be re-picked
  });
  picker.appendChild(input);

  const sample = (text: string, label: string, filename: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = BTN;
    b.textContent = label;
    b.addEventListener("click", () => tryLoad(text, filename));
    return b;
  };

  bar.append(
    picker,
    sample(SAMPLE_PAJEK, "Sample .net", "sample.net"),
    sample(SAMPLE_EDGELIST, "Sample edges", "sample.txt"),
    error,
  );
  return bar;
}
