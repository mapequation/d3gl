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
   * Switch the rendering backend in place, preserving the current zoom/pan view and
   * layers (the engine's `setBackend` re-pushes layer specs + transform onto the new
   * backend). Omit if the example can't swap backend without a full remount.
   */
  setBackend?(backend: Backend): void;
  /**
   * Export the current rendering. The format matches the active backend:
   * "svg" → SVG markup; "webgl"/"canvas" → a PNG data URL.
   */
  exportImage(): { format: "svg" | "png"; data: string };
}

/** Display size (CSS px) of the canvas container, measured at mount time. The example
 *  should render at exactly this size (1:1, drawing-buffer == display) so pointer, GPU
 *  geometry and HTML label overlays all share one coordinate space. */
export interface ExampleSize { width: number; height: number; }

export type MountFn = (el: HTMLElement, opts: ExampleOptions, size: ExampleSize) => ExampleHandle;

// ---------------------------------------------------------------------------
// New React <Example> harness contracts. The harness flows everything through
// props + a `registerEngine` callback (no DOM querying, no custom events). Both
// `geoMap` and `plot` engines satisfy `ExampleEngine`.
// ---------------------------------------------------------------------------

/** Minimal engine surface the harness needs (geoMap/plot both satisfy this). */
export interface ExampleEngine {
  setBackend(b: Backend): void;
  toPNG(): string;
  toSVG(): string;
  destroy(): void;
}

/** Context the harness hands to its render-prop child (and, minus
 *  `registerEngine`, to an imperative `setup`). */
export interface ExampleContext {
  backend: Backend;
  width: number;
  height: number;
  /** Example-specific control values (keyed by ControlSpec.key). */
  options: Record<string, unknown>;
  /** The viz calls this once its engine is built so the harness can export. */
  registerEngine: (engine: ExampleEngine) => void;
}

/**
 * Imperative example: build the d3gl engine into `host` and return it. May also
 * return an object with the engine plus optional extra cleanup (e.g. disposing a
 * LabelLayer). The `.ts` module exporting this is what the code tab shows, so it
 * stays pure d3gl with zero framework/plumbing.
 */
export type ImperativeSetup = (
  host: HTMLElement,
  ctx: Omit<ExampleContext, "registerEngine">,
) => ExampleEngine | { engine: ExampleEngine; dispose?: () => void };

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
