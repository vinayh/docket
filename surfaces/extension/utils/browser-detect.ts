import { browser } from "wxt/browser";

const QUIRKS_KEY = "browserQuirks";

export interface BrowserQuirks {
  /**
   * True only when we're confident the host browser's native side panel
   * actually renders: Firefox (its own `sidebarAction` UI) or real Google
   * Chrome (the `chrome.sidePanel` UI). Everything else — Edge, Brave, Opera,
   * Arc, the long tail of Chromium derivatives — gets a detached popup
   * window instead, even when `chrome.sidePanel` is exposed and resolves
   * without error. We picked this stance because the API resolves silently
   * on too many of those derivatives, with no event to discriminate.
   */
  nativeSidebarSupported: boolean;
}

/**
 * Detection runs from any extension-page entrypoint (popup, options) and
 * persists the result so the SW can read it sync at action-click time.
 * Idempotent — only writes when the boolean changes.
 *
 * SW also gets to call `detectNativeSidebarSupport()` directly at startup
 * for the UA-only signal; the page-context call here adds the Arc CSS-vars
 * probe on top.
 */
export async function detectAndPersistBrowserQuirks(): Promise<void> {
  const next: BrowserQuirks = {
    nativeSidebarSupported: detectNativeSidebarSupport(),
  };
  const stored = (await browser.storage.local.get(QUIRKS_KEY))[QUIRKS_KEY] as
    | BrowserQuirks
    | undefined;
  if (stored?.nativeSidebarSupported === next.nativeSidebarSupported) return;
  await browser.storage.local.set({ [QUIRKS_KEY]: next });
}

export async function getBrowserQuirks(): Promise<BrowserQuirks | null> {
  const out = await browser.storage.local.get(QUIRKS_KEY);
  return (out[QUIRKS_KEY] as BrowserQuirks | undefined) ?? null;
}

export const BROWSER_QUIRKS_STORAGE_KEY = QUIRKS_KEY;

/**
 * Decide whether the host browser's native sidebar UI is safe to use. Returns
 * true for Firefox and for real Google Chrome; false for every Chromium
 * derivative we can identify (Edge, Brave, Opera, Arc) and false by default
 * for the long tail of unknown Chromium browsers.
 *
 * Callable from both page contexts (popup/options — full check including
 * Arc CSS vars) and from the SW (UA-only check; Arc detection requires DOM).
 */
export function detectNativeSidebarSupport(): boolean {
  if (isFirefox()) return true;
  if (!isRealChrome()) return false;
  // Real Chrome by every UA signal we have. If we're in a page context, also
  // rule out Arc — Arc mimics Chrome perfectly in `userAgentData` but injects
  // its own CSS custom properties.
  if (typeof document !== "undefined" && hasArcPaletteVars()) return false;
  return true;
}

function isFirefox(): boolean {
  // Firefox's `userAgentData` is undefined (Firefox hasn't shipped UA-CH), so
  // the UA string is the signal that matters. `sidebarAction` presence is
  // also Firefox-specific, but only available in extension contexts that have
  // imported `wxt/browser` first — the UA check is enough.
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /\bFirefox\/\d/.test(ua);
}

function isRealChrome(): boolean {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  if (!nav) return false;
  // Brave exposes `navigator.brave.isBrave`; treat its presence as a Brave
  // signal even before the async probe resolves.
  if ((nav as { brave?: unknown }).brave) return false;
  const ua = nav.userAgent ?? "";
  // Spelled this way in Edge / Opera UA strings; both also report themselves
  // in `userAgentData.brands`, so this is belt-and-braces.
  if (/\b(Edg|EdgA|EdgiOS)\//.test(ua)) return false;
  if (/\bOPR\//.test(ua)) return false;

  const brands = (nav as Navigator & {
    userAgentData?: { brands?: { brand: string }[] };
  }).userAgentData?.brands;
  if (!brands || brands.length === 0) {
    // No UA-CH support: we can't positively identify Chrome here. Be
    // conservative — return false so unknown Chromium browsers get the
    // detached window.
    return false;
  }
  const brandNames = brands.map((b) => b.brand);
  // Edge / Opera surface themselves explicitly; Chrome's brands include
  // "Google Chrome" but not those.
  if (brandNames.some((b) => b === "Microsoft Edge")) return false;
  if (brandNames.some((b) => b === "Opera")) return false;
  return brandNames.some((b) => b === "Google Chrome");
}

function hasArcPaletteVars(): boolean {
  // Arc Browser injects `--arc-palette-*` CSS custom properties into the root
  // of every page it renders. Stable across Arc 1.x. Chrome / Edge / Brave /
  // Firefox don't ship these, so a non-empty value on any probe is
  // definitive.
  const styles = getComputedStyle(document.documentElement);
  const probes = [
    "--arc-palette-background",
    "--arc-palette-foregroundPrimary",
    "--arc-palette-title",
    "--arc-palette-subtitle",
  ];
  return probes.some((name) => styles.getPropertyValue(name).trim().length > 0);
}
