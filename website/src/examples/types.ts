export type Backend = "webgl" | "canvas" | "svg";

export interface ExampleOptions {
  backend: Backend;
  /** Example-specific options (e.g. layout, curve, coords). */
  [key: string]: unknown;
}

export interface ExampleHandle {
  /** Tear down listeners and GPU resources. */
  dispose(): void;
  /**
   * Export the current rendering. The format matches the active backend:
   * "svg" → SVG markup; "webgl"/"canvas" → a PNG data URL.
   */
  exportImage(): { format: "svg" | "png"; data: string };
}

export type MountFn = (el: HTMLElement, opts: ExampleOptions) => ExampleHandle;

/** Declares one example-specific control rendered in the shared control bar. */
export type ControlSpec =
  | {
      type?: "segmented";
      /** Option key this control sets (e.g. "layout"). */
      key: string;
      label: string;
      /** Segmented options; first is the default. */
      options: string[];
    }
  | {
      type: "range";
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      /** Initial numeric value (also the default written into opts[key]). */
      value: number;
      /** Optional per-step display labels, indexed by (value - min) / step (e.g. ["1°","2°"]). */
      display?: string[];
    };
