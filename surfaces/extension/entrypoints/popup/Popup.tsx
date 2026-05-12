import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";
import { cleanDocTitle, parseDocIdFromUrl } from "../../utils/ids.ts";
import type { DocState } from "../../utils/types.ts";
import { Header } from "../../ui/Header.tsx";
import { getSettingsStatus, sendMessage } from "../../ui/sendMessage.ts";
import { Diagnostics } from "./Diagnostics.tsx";
import { NoSettings } from "./views/NoSettings.tsx";
import { NeedsSignIn } from "./views/NeedsSignIn.tsx";
import { NoDoc } from "./views/NoDoc.tsx";
import { Untracked } from "./views/Untracked.tsx";
import { Tracked } from "./views/Tracked.tsx";
import { ErrorView } from "./views/ErrorView.tsx";

/**
 * Popup state machine. The single `View` union below drives all rendering;
 * async flows live here so the view components stay pure render fns.
 *
 * "Add to Margin" no longer renders a sandboxed Picker iframe in the
 * popup — Google's `origin_mismatch` policy on `chrome-extension://`
 * origins broke that path. Instead the popup opens the backend-hosted
 * Drive Picker at `/api/picker/page` in a new tab; the page runs on the
 * backend origin (which the OAuth client allow-lists), registers the
 * picked doc against `/api/picker/register-doc` directly, and the user
 * comes back to the original Docs tab. Re-opening the popup re-runs
 * `doc/state` and flips into the tracked view automatically.
 */

export interface ActiveDocTab {
  docId: string;
  /**
   * Doc name derived from `tab.title` with the " - Google Docs" locale
   * suffix stripped (see `cleanDocTitle`). Empty when Chrome hasn't
   * populated the tab title yet.
   */
  title: string;
}

export type TrackedState = Extract<DocState, { tracked: true }>;

export type View =
  | { kind: "loading" }
  | { kind: "no-settings" }
  | { kind: "needs-sign-in"; backendUrl: string }
  | { kind: "no-doc" }
  | { kind: "untracked"; tab: ActiveDocTab }
  | { kind: "tracked"; tab: ActiveDocTab; state: TrackedState }
  | { kind: "error"; tab: ActiveDocTab | null; message: string };

export function Popup() {
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    void boot(setView);
    // The tab-based sign-in flow lands `settings.sessionToken` into
    // `chrome.storage.local` via the SW (Chromium via onMessageExternal,
    // Firefox via tabs.onUpdated reading the bridge fragment). Watching
    // for that lets the popup flip from "needs sign-in" into the
    // tracked/untracked view without the user closing and reopening it.
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: chrome.storage.AreaName,
    ) => {
      if (areaName !== "local" || !changes.settings) return;
      const before = (changes.settings.oldValue as { sessionToken?: string } | undefined)
        ?.sessionToken ?? "";
      const after = (changes.settings.newValue as { sessionToken?: string } | undefined)
        ?.sessionToken ?? "";
      if (before !== after) void boot(setView);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);

  return (
    <>
      <Header />
      <main id="main">
        <ViewBody view={view} setView={setView} />
      </main>
      <Diagnostics initiallyOpen={view.kind === "no-settings"} />
    </>
  );
}

interface BodyProps {
  view: View;
  setView: (v: View) => void;
}

function ViewBody({ view, setView }: BodyProps) {
  switch (view.kind) {
    case "loading":
      return <p class="muted">Loading…</p>;
    case "no-settings":
      return <NoSettings />;
    case "needs-sign-in":
      return (
        <NeedsSignIn
          backendUrl={view.backendUrl}
          onSignedIn={() => void boot(setView)}
        />
      );
    case "no-doc":
      return <NoDoc />;
    case "untracked":
      return (
        <Untracked
          tab={view.tab}
          onAdd={() => void startAddFlow(view.tab, setView)}
        />
      );
    case "tracked":
      return (
        <Tracked
          tab={view.tab}
          state={view.state}
          onSync={() => void runSync(view.tab, setView)}
        />
      );
    case "error":
      return (
        <ErrorView
          tab={view.tab}
          message={view.message}
          onRetry={
            view.tab ? () => void renderDocState(view.tab!, setView) : null
          }
        />
      );
  }
}

// ---- async flows ---------------------------------------------------------

async function boot(setView: (v: View) => void): Promise<void> {
  const { settings, backendUrl } = await getSettingsStatus();
  if (!settings) {
    if (backendUrl) {
      setView({ kind: "needs-sign-in", backendUrl });
    } else {
      setView({ kind: "no-settings" });
    }
    return;
  }
  const tab = await getActiveDocTab();
  if (!tab) {
    setView({ kind: "no-doc" });
    return;
  }
  await renderDocState(tab, setView);
}

async function renderDocState(
  tab: ActiveDocTab,
  setView: (v: View) => void,
): Promise<void> {
  let state: DocState | null;
  try {
    const r = await sendMessage({ kind: "doc/state", docId: tab.docId });
    state = r?.kind === "doc/state" ? r.state : null;
    if (r && "error" in r && r.error) {
      setView({ kind: "error", tab, message: r.error });
      return;
    }
  } catch (err) {
    setView({
      kind: "error",
      tab,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!state) {
    setView({ kind: "error", tab, message: "no response from backend" });
    return;
  }
  if (!state.tracked) {
    setView({ kind: "untracked", tab });
    return;
  }
  setView({ kind: "tracked", tab, state });
}

async function runSync(
  tab: ActiveDocTab,
  setView: (v: View) => void,
): Promise<void> {
  try {
    const r = await sendMessage({ kind: "doc/sync", docId: tab.docId });
    if (r?.kind !== "doc/sync") {
      setView({ kind: "error", tab, message: "no response from backend" });
      return;
    }
    if (r.error) {
      setView({ kind: "error", tab, message: r.error });
      return;
    }
    if (r.state?.tracked) {
      setView({ kind: "tracked", tab, state: r.state });
      return;
    }
    if (r.state && !r.state.tracked) {
      setView({ kind: "untracked", tab });
      return;
    }
    setView({ kind: "error", tab, message: "no response from backend" });
  } catch (err) {
    setView({
      kind: "error",
      tab,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Open the backend-hosted Drive Picker in a new tab. The page runs on
 * the backend origin (which the OAuth client allow-lists, unlike
 * `chrome-extension://`), pulls a fresh Drive access token from the
 * user's session, registers the picked doc via
 * `/api/picker/register-doc`, and closes itself. The popup closes after
 * launching the tab; re-opening it on the original Docs tab picks up
 * the new tracked state via `doc/state`.
 */
async function startAddFlow(
  tab: ActiveDocTab,
  setView: (v: View) => void,
): Promise<void> {
  const { backendUrl } = await getSettingsStatus();
  if (!backendUrl) {
    setView({
      kind: "error",
      tab,
      message: "Backend URL is not configured.",
    });
    return;
  }
  const base = backendUrl.replace(/\/+$/, "");
  const url = `${base}/api/picker/page?docId=${encodeURIComponent(tab.docId)}`;
  await browser.tabs.create({ url });
  window.close();
}

// ---- helpers -------------------------------------------------------------

async function getActiveDocTab(): Promise<ActiveDocTab | null> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url) return null;
  const docId = parseDocIdFromUrl(tab.url);
  if (!docId) return null;
  return { docId, title: cleanDocTitle(tab.title) };
}
