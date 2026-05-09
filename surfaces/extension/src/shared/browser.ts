/**
 * Cross-browser API shim. We avoid depending on `webextension-polyfill` —
 * it's a 30 KB bundle dwarfing our actual code. Modern Chrome / Edge /
 * Firefox all expose Promise-based methods on the `chrome.*` namespace
 * (and Firefox additionally aliases as `browser.*`); this module presents
 * a single typed handle.
 *
 * Add minimal surface only — adding everything `chrome.*` exposes would
 * defeat the point.
 */

type ChromeLike = typeof chrome;

declare global {
  // Firefox aliases the API as `browser.*`. Both work in Firefox; only
  // `chrome.*` works in Chromium. Pick `browser` first if it's present
  // (some Firefox-only fields only appear there).
  // biome-ignore lint/suspicious/noExplicitAny: declared on globalThis at runtime
  var browser: ChromeLike | undefined;
}

export const ext: ChromeLike =
  (typeof globalThis.browser !== "undefined" && globalThis.browser) || chrome;
