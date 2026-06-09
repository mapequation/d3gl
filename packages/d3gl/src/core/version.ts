// `__D3GL_VERSION__` is replaced at build time with the `package.json` version
// (see tsdown.config.ts `define`). The `typeof` guard keeps source-level / unbundled
// imports working without a build step — when the constant is not substituted
// (e.g. the website's `src` aliases, vitest) it reads as `"undefined"` rather than
// throwing a ReferenceError, and we fall back to a dev sentinel.
declare const __D3GL_VERSION__: string;

/**
 * The d3gl package version, injected at build time from `package.json`.
 *
 * Lets downstream apps surface the version (e.g. a "Powered by d3gl" badge)
 * without importing `@mapequation/d3gl/package.json`:
 *
 * ```ts
 * import { version } from "@mapequation/d3gl";
 * console.log(`Powered by d3gl v${version}`);
 * ```
 */
export const version: string =
  typeof __D3GL_VERSION__ === "string" ? __D3GL_VERSION__ : "0.0.0-dev";
