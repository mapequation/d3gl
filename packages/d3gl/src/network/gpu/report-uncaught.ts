/**
 * Report an error as uncaught without throwing it at the caller (#352): through `reportError` where the
 * runtime has it (it logs the error and fires the global `error` event, as an exception escaping a
 * callback would), otherwise by rethrowing it from a task of its own — the same outcome on runtimes that
 * predate `reportError` (pre-2022 browsers, some embedded webviews, Node).
 */
export function reportUncaught(error: unknown): void {
  if (typeof reportError === "function") reportError(error);
  else
    setTimeout(() => {
      throw error;
    }, 0);
}
