import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";
import { cleanDocTitleFallback, parseDocIdFromUrl } from "../../utils/ids.ts";
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

// Popup state machine. The View union below drives rendering; views stay pure.
// "Add to Margin" opens the backend-hosted Drive Picker in a new tab — chrome-extension:// origins
// fail Google's origin_mismatch check, so the picker can't live in the popup itself.

export interface ActiveDocTab {
  docId: string;
  // tab.title with the locale-specific " - Google Docs" suffix stripped via
  // `cleanDocTitleFallback`. Best-effort and only used when the backend's
  // canonical `DocState.title` isn't available (untracked / legacy rows).
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
    // Re-boot when settings.sessionToken changes so post-sign-in state lands without a reopen.
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

// Opens the backend-hosted Drive Picker in a new tab; the popup closes itself afterward.
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
  return { docId, title: cleanDocTitleFallback(tab.title) };
}
