import { useEffect, useRef } from "react";
import type { ExampleContext, ExampleEngine, ImperativeSetup } from "../examples/types.js";

export interface ImperativeProps {
  ctx: ExampleContext;
  setup: ImperativeSetup;
}

/**
 * Renders an imperative d3gl example so its source file (`setup`) stays pure
 * d3gl with zero React/plumbing. It builds the engine into a host `<div>` and
 * reacts to the harness `ctx`:
 *
 *   - on size/options change: tear down, re-run `setup`, register the engine;
 *   - on backend change ONLY: call `engine.setBackend()` (no rebuild → zoom/pan
 *     and layers are preserved by the engine).
 */
export default function Imperative({ ctx, setup }: ImperativeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ExampleEngine | null>(null);
  const disposeRef = useRef<(() => void) | undefined>(undefined);

  const { backend, width, height, options, registerEngine } = ctx;
  const optionsKey = JSON.stringify(options);

  // Build / rebuild on size or options change (NOT backend — that would rebuild
  // and lose the current zoom/pan).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || width < 2 || height < 2) return;
    disposeRef.current?.();
    engineRef.current?.destroy();
    host.replaceChildren();

    const result = setup(host, { backend, width, height, options });
    const engine = "engine" in result ? result.engine : result;
    const dispose = "engine" in result ? result.dispose : undefined;
    engineRef.current = engine;
    disposeRef.current = dispose;
    registerEngine(engine);

    return () => {
      disposeRef.current?.();
      engineRef.current?.destroy();
      host.replaceChildren();
      engineRef.current = null;
      disposeRef.current = undefined;
    };
    // Backend deliberately excluded; handled by the swap effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, optionsKey]);

  // Swap backend in place, preserving zoom/pan + layers.
  useEffect(() => {
    engineRef.current?.setBackend(backend);
  }, [backend]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
