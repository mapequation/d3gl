export type Backend = "webgl" | "canvas" | "svg";

// ---------------------------------------------------------------------------
// React <Example> harness contracts. The harness flows everything through
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
 * return an object with the engine plus:
 *   - `render(options)` — (re)builds the option-dependent layers on the EXISTING
 *     engine when a control changes, so the engine (and its zoom/pan) is reused.
 *     It MUST NOT reset the engine's transform (base/initial view setup belongs in
 *     `setup`), otherwise zoom is lost on every option change.
 *   - `dispose()` — optional extra cleanup (e.g. disposing a LabelLayer).
 *
 * If a `setup` returns just an engine (or omits `render`), the harness recreates
 * the engine on option changes — backward compatible for controls-free examples.
 * The `.ts` module exporting this is what the code tab shows, so it stays pure
 * d3gl with zero framework/plumbing.
 */
export type ImperativeSetup = (
  host: HTMLElement,
  ctx: Omit<ExampleContext, "registerEngine">,
) =>
  | ExampleEngine
  | {
      engine: ExampleEngine;
      render?: (options: Record<string, unknown>) => void;
      dispose?: () => void;
    };

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
    }
  | {
      type: "select";
      key: string;
      label: string;
      /** Option values (value === visible label). */
      options: string[];
      /** Default value (else options[0]). */
      value?: string;
    };
