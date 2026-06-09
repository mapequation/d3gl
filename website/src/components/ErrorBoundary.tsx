import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors thrown inside an example so a single failing
 * example (e.g. switching a passThrough example to the SVG backend, which throws
 * "passThrough is not supported by the svg backend") shows a recoverable UI
 * instead of crashing the whole page. Async failures (e.g. the engine's
 * setBackend swap promise rejecting) are surfaced into render by the caller and
 * caught here too.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // eslint-disable-next-line no-console
    console.error("Example error:", error);
  }

  reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="bg-card text-foreground flex h-full flex-col items-start justify-center gap-2 p-6">
          <p className="text-sm font-medium">This example hit an error</p>
          <p className="text-muted-foreground font-mono text-xs break-words">
            {error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="border-border bg-background text-foreground hover:bg-muted focus-visible:ring-outline/50 mt-1 inline-flex h-6 items-center justify-center rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2"
          >
            Reload example
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
