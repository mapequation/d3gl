import { useEffect, useRef } from "react";
import type { ExampleContext, ExampleEngine, ImperativeSetup } from "../examples/types.js";

export interface ImperativeProps {
  ctx: ExampleContext;
  setup: ImperativeSetup;
}

type RenderFn = (options: Record<string, unknown>) => void;

/**
 * Renders an imperative d3gl example so its source file (`setup`) stays pure
 * d3gl with zero React/plumbing. It builds the engine into a host `<div>` and
 * reacts to the harness `ctx`:
 *
 *   - on SIZE change (width/height): tear down, re-run `setup`, register the
 *     engine, then call `render(options)` for the initial option-dependent
 *     content. A new canvas of a different size genuinely needs a new engine.
 *   - on OPTIONS change: if `setup` returned a `render`, call it on the EXISTING
 *     engine — it re-applies the option-dependent layers without touching the
 *     transform, so the user's zoom/pan is preserved. If there is no `render`
 *     (controls-free example), recreate the engine (backward-compatible fallback).
 *   - on BACKEND change ONLY: call `engine.setBackend()` (no rebuild → zoom/pan
 *     and layers are preserved by the engine).
 */
export default function Imperative({ ctx, setup }: ImperativeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ExampleEngine | null>(null);
  const renderRef = useRef<RenderFn | undefined>(undefined);
  const disposeRef = useRef<(() => void) | undefined>(undefined);
  const visibleRef = useRef<((visible: boolean) => void) | undefined>(undefined);
  // The options key the engine was last built/rendered with, so the options effect can skip
  // the redundant run that fires right after the size effect builds the engine.
  const builtOptionsKey = useRef<string | null>(null);

  const { backend, width, height, options, registerEngine } = ctx;
  const optionsKey = JSON.stringify(options);

  // Build / rebuild on SIZE change only. Backend and options are handled by the
  // effects below so they don't recreate the engine (which would reset zoom/pan).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || width < 2 || height < 2) return;

    const result = setup(host, { backend, width, height, options });
    const engine = "engine" in result ? result.engine : result;
    const render = "engine" in result ? result.render : undefined;
    const dispose = "engine" in result ? result.dispose : undefined;
    engineRef.current = engine;
    renderRef.current = render;
    disposeRef.current = dispose;
    visibleRef.current = "engine" in result ? result.setVisible : undefined;
    registerEngine(engine);
    // Initial option-dependent content (if this example builds layers in render).
    render?.(options);
    builtOptionsKey.current = optionsKey;

    return () => {
      disposeRef.current?.();
      engineRef.current?.destroy();
      host.replaceChildren();
      engineRef.current = null;
      renderRef.current = undefined;
      disposeRef.current = undefined;
      visibleRef.current = undefined;
    };
    // Only SIZE recreates the engine; backend/options are handled separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // Options change: re-apply layers on the EXISTING engine (zoom preserved). If
  // the example has no `render`, recreate it as a fallback.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !engineRef.current) return;
    // Skip the run that fires immediately after the size effect built the engine with these
    // same options (avoids a redundant render / engine recreate on mount).
    if (builtOptionsKey.current === optionsKey) return;
    builtOptionsKey.current = optionsKey;
    if (renderRef.current) {
      renderRef.current(options);
      return;
    }
    // Fallback: no render → recreate the engine on options change.
    disposeRef.current?.();
    engineRef.current.destroy();
    host.replaceChildren();
    const result = setup(host, { backend, width, height, options });
    const engine = "engine" in result ? result.engine : result;
    engineRef.current = engine;
    renderRef.current = "engine" in result ? result.render : undefined;
    disposeRef.current = "engine" in result ? result.dispose : undefined;
    visibleRef.current = "engine" in result ? result.setVisible : undefined;
    registerEngine(engine);
    renderRef.current?.(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey]);

  // Tell the example when its canvas enters/leaves the viewport or the tab is
  // hidden, so it can pause offscreen work (e.g. streaming). The harness owns the
  // observer; the example just implements setVisible if it cares.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let inView = true;
    const emit = (): void => visibleRef.current?.(inView && document.visibilityState !== "hidden");
    const io = new IntersectionObserver((entries) => {
      inView = entries[0]?.isIntersecting ?? true;
      emit();
    });
    io.observe(host);
    const onVisibility = (): void => emit();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Swap backend in place, preserving zoom/pan + layers.
  useEffect(() => {
    engineRef.current?.setBackend(backend);
  }, [backend]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
