import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";
import { parseDocIdFromUrl } from "../../utils/ids.ts";
import { getDocTitle } from "../../utils/storage.ts";
import type {
  DocState,
  PickerConfig,
  RegisterDocResult,
} from "../../utils/types.ts";
import { Header } from "../../ui/Header.tsx";
import { getSettings, sendMessage } from "../../ui/sendMessage.ts";
import { Diagnostics } from "./Diagnostics.tsx";
import { PickerOverlay } from "./PickerOverlay.tsx";
import { NoSettings } from "./views/NoSettings.tsx";
import { NoDoc } from "./views/NoDoc.tsx";
import { Untracked } from "./views/Untracked.tsx";
import { Tracked } from "./views/Tracked.tsx";
import { ErrorView } from "./views/ErrorView.tsx";

/**
 * Popup state machine. The single `View` union below replaces the original
 * popup.ts's six render-* functions + module-level mutable state for the
 * picker handshake. Top-level setView drives all transitions; flows live
 * here so the view components stay pure render fns.
 *
 * On Firefox MV3 the sandboxed picker is unsupported (no `sandbox.pages`),
 * so `startAddFlow` opens the backend `/picker` tab instead.
 */

export interface ActiveDocTab {
  docId: string;
  /** Real doc name from chrome.storage.local; empty until the content script scrapes it. */
  title: string;
}

export type TrackedState = Extract<DocState, { tracked: true }>;

export type View =
  | { kind: "loading" }
  | { kind: "no-settings" }
  | { kind: "no-doc" }
  | { kind: "untracked"; tab: ActiveDocTab }
  | { kind: "tracked"; tab: ActiveDocTab; state: TrackedState }
  | { kind: "error"; tab: ActiveDocTab | null; message: string }
  | { kind: "picker"; tab: ActiveDocTab; cfg: PickerConfig }
  | { kind: "registering"; tab: ActiveDocTab; heading: string };

export function Popup() {
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    void boot(setView);
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
    case "picker":
      return (
        <PickerOverlay
          tab={view.tab}
          cfg={view.cfg}
          onPicked={(docId, name) =>
            void completeRegistration(view.tab, docId, name, setView)
          }
          onCancelled={() => setView({ kind: "untracked", tab: view.tab })}
          onError={(message) =>
            setView({ kind: "error", tab: view.tab, message })
          }
        />
      );
    case "registering":
      return (
        <>
          <p class="title" title={view.heading}>
            {view.heading}
          </p>
          <p class="muted">Registering with Margin…</p>
        </>
      );
  }
}

// ---- async flows ---------------------------------------------------------

async function boot(setView: (v: View) => void): Promise<void> {
  const settings = await getSettings();
  if (!settings) {
    setView({ kind: "no-settings" });
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
 * Decides between in-popup sandboxed Picker (Chromium) and backend `/picker`
 * tab fallback (Firefox MV3 lacks `sandbox.pages` support). On Chromium it
 * fetches the Picker config and transitions to the `picker` view; the
 * `<PickerOverlay/>` then owns the iframe lifecycle and message handshake.
 */
async function startAddFlow(
  tab: ActiveDocTab,
  setView: (v: View) => void,
): Promise<void> {
  if (navigator.userAgent.includes("Firefox")) {
    const settings = await getSettings();
    if (!settings) {
      setView({ kind: "error", tab, message: "no backend configured" });
      return;
    }
    const params = new URLSearchParams({
      token: settings.apiToken,
      suggestedDocId: tab.docId,
    });
    if (tab.title) params.set("suggestedTitle", tab.title);
    const base = settings.backendUrl.replace(/\/+$/, "");
    await browser.tabs.create({ url: `${base}/picker#${params.toString()}` });
    window.close();
    return;
  }

  const r = await sendMessage({ kind: "picker/config" });
  const cfg = r?.kind === "picker/config" ? r.config : null;
  if (!cfg) {
    setView({
      kind: "error",
      tab,
      message:
        "Picker is not configured on the backend (GOOGLE_CLIENT_ID / GOOGLE_API_KEY / GOOGLE_PROJECT_NUMBER missing).",
    });
    return;
  }
  setView({ kind: "picker", tab, cfg });
}

async function completeRegistration(
  tab: ActiveDocTab,
  docId: string,
  name: string,
  setView: (v: View) => void,
): Promise<void> {
  const heading = name || tab.title || "Google Doc";
  setView({ kind: "registering", tab, heading });
  const r = await sendMessage({ kind: "doc/register", docUrlOrId: docId });
  const result: RegisterDocResult | null =
    r?.kind === "doc/register" ? r.result : null;
  if (!result) {
    setView({ kind: "error", tab, message: "no response from backend" });
    return;
  }
  if (result.kind === "error") {
    setView({ kind: "error", tab, message: result.message });
    return;
  }
  // Success — re-fetch state so the tracked view reflects the new project.
  // Use the originally-open tab's docId; register-doc accepts either parent
  // or version doc ids, but the popup is contextual to the open doc.
  await renderDocState(tab, setView);
}

// ---- helpers -------------------------------------------------------------

async function getActiveDocTab(): Promise<ActiveDocTab | null> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url) return null;
  const docId = parseDocIdFromUrl(tab.url);
  if (!docId) return null;
  const title = (await getDocTitle(docId)) ?? "";
  return { docId, title };
}
