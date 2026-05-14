import { browser } from "wxt/browser";
import { detectNativeSidebarSupport, getBrowserQuirks } from "./browser-detect.ts";

// Detached-window fallback for the dashboard. Sized to feel like a side panel,
// not a full popup window. Users can resize/move it.
const FALLBACK_WIDTH = 480;
const FALLBACK_HEIGHT = 800;
const SIDEPANEL_PATH = "sidepanel.html";
const OPTIONS_PATH = "options.html";

interface SidebarApi {
  sidePanel?: {
    open: (opts: { windowId?: number; tabId?: number }) => Promise<void>;
  };
  sidebarAction?: { open: () => Promise<void> };
}

/**
 * Resolve whether the native sidebar should be used in the current context.
 * Reads the persisted `browserQuirks` flag (written by extension-page entries
 * that ran the full Arc CSS-vars probe). Falls back to the UA-only probe
 * when the flag isn't present yet — that path runs even in the SW.
 */
export async function shouldUseNativeSidebar(): Promise<boolean> {
  const quirks = await getBrowserQuirks();
  if (quirks) return quirks.nativeSidebarSupported;
  return detectNativeSidebarSupport();
}

/**
 * Open the dashboard surface. In Firefox / real Google Chrome this opens the
 * native sidebar (`sidebarAction.open` / `sidePanel.open`). Everywhere else
 * — Edge, Brave, Opera, Arc, unknown Chromium derivatives — it opens a
 * detached popup window loading `sidepanel.html`. Repeat clicks focus an
 * existing detached window instead of stacking duplicates.
 *
 * `useNativeSidebar` is the *cached* boolean from the SW (so the click
 * handler can dispatch synchronously, keeping the user gesture intact for
 * the native sidebar call). Callers without a synchronous cache should
 * await `shouldUseNativeSidebar()` first.
 */
export async function openDashboard(opts: {
  useNativeSidebar: boolean;
  windowId?: number;
  tabId?: number;
}): Promise<void> {
  if (opts.useNativeSidebar) {
    const api = browser as unknown as SidebarApi;
    if (api.sidePanel?.open) {
      const param: { windowId?: number; tabId?: number } =
        opts.windowId !== undefined ? { windowId: opts.windowId } : { tabId: opts.tabId };
      try {
        await api.sidePanel.open(param);
        return;
      } catch (err) {
        console.warn("[margin] sidePanel.open rejected, falling back to window:", err);
      }
    } else if (api.sidebarAction?.open) {
      try {
        await api.sidebarAction.open();
        return;
      } catch (err) {
        console.warn("[margin] sidebarAction.open rejected, falling back to window:", err);
      }
    }
    // Fall through to the detached-window path if the native API rejected
    // — at least the user sees the dashboard.
  }
  await openOrFocusSidepanelWindow();
}

async function openOrFocusSidepanelWindow(): Promise<void> {
  const url = browser.runtime.getURL(`/${SIDEPANEL_PATH}`);
  // tabs.query by URL works for the extension's own pages without the "tabs"
  // permission. Derive the host window and prefer popup-type windows so we
  // don't focus the same URL accidentally opened as a normal tab.
  const matches = await browser.tabs.query({ url });
  for (const tab of matches) {
    if (tab.windowId === undefined) continue;
    const win = await browser.windows.get(tab.windowId);
    if (win.type === "popup" && win.id !== undefined) {
      await browser.windows.update(win.id, { focused: true });
      return;
    }
  }
  await browser.windows.create({
    url,
    type: "popup",
    width: FALLBACK_WIDTH,
    height: FALLBACK_HEIGHT,
  });
}

/**
 * Open the Options page. Uses `tabs.create` directly rather than
 * `runtime.openOptionsPage()`: the manifest already declares
 * `options_ui.open_in_tab: true`, so Chrome's helper is just an indirection
 * — and some Chromium derivatives (Arc) resolve `openOptionsPage()` without
 * rendering anything. `tabs.create` is reliable everywhere.
 */
export async function openOptions(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(`/${OPTIONS_PATH}`) });
}
