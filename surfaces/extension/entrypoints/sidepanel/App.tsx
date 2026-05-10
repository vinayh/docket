import { useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";
import { parseDocIdFromUrl } from "../../utils/ids.ts";
import { Header } from "../../ui/Header.tsx";
import { sendMessage } from "../../ui/sendMessage.ts";
import type {
  DocState,
  ProjectDetail,
  Settings,
} from "../../utils/types.ts";
import { Dashboard } from "./views/Dashboard.tsx";
import { VersionDiff } from "./views/VersionDiff.tsx";

/**
 * Side-panel root. Mirrors the popup's state-machine shape but pivots on
 * "is there a tracked project we can render a dashboard for?" rather than
 * "is the active tab a Docs URL?". When the active tab is a known-tracked
 * doc, the panel jumps straight to that project; otherwise it waits for the
 * user to navigate to one (the panel persists across tabs in Chromium).
 */

type View =
  | { kind: "loading" }
  | { kind: "no-settings" }
  | { kind: "no-project" }
  | { kind: "loaded"; detail: ProjectDetail }
  | { kind: "diff"; detail: ProjectDetail; fromVersionId: string; toVersionId: string }
  | { kind: "error"; message: string };

export function App() {
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    void boot(setView);

    // Re-resolve when the user navigates the active tab so the panel
    // follows the doc context. Chromium fires `tabs.onActivated` /
    // `tabs.onUpdated`; Firefox sidebar same shape. We listen for both
    // and debounce identical reruns inside boot().
    const listener = (): void => {
      void boot(setView);
    };
    browser.tabs.onActivated.addListener(listener);
    browser.tabs.onUpdated.addListener(listener);
    return () => {
      browser.tabs.onActivated.removeListener(listener);
      browser.tabs.onUpdated.removeListener(listener);
    };
  }, []);

  return (
    <>
      <Header />
      <main id="main">
        <Body view={view} setView={setView} />
      </main>
    </>
  );
}

function Body({ view, setView }: { view: View; setView: (v: View) => void }) {
  switch (view.kind) {
    case "loading":
      return <p class="muted">Loading…</p>;
    case "no-settings":
      return (
        <>
          <p class="title">Side panel</p>
          <p class="muted">
            Configure the backend URL + API token in Options to load project
            data.
          </p>
        </>
      );
    case "no-project":
      return (
        <>
          <p class="title">No project</p>
          <p class="muted">
            Open a Google Doc that's tracked by Docket — or add a new project
            from the toolbar popup — to see its dashboard here.
          </p>
        </>
      );
    case "loaded":
      return (
        <Dashboard
          detail={view.detail}
          onOpenDiff={(fromVersionId, toVersionId) =>
            setView({
              kind: "diff",
              detail: view.detail,
              fromVersionId,
              toVersionId,
            })
          }
        />
      );
    case "diff":
      return (
        <VersionDiff
          fromVersionId={view.fromVersionId}
          toVersionId={view.toVersionId}
          onClose={() => setView({ kind: "loaded", detail: view.detail })}
        />
      );
    case "error":
      return (
        <>
          <p class="title">Error</p>
          <p class="muted">{view.message}</p>
        </>
      );
  }
}

async function boot(setView: (v: View) => void): Promise<void> {
  const settings = await getSettings();
  if (!settings) {
    setView({ kind: "no-settings" });
    return;
  }

  const docId = await getActiveDocId();
  if (!docId) {
    setView({ kind: "no-project" });
    return;
  }

  try {
    const state = await fetchDocState(docId);
    if (!state || !state.tracked) {
      setView({ kind: "no-project" });
      return;
    }
    const detail = await fetchProjectDetail(state.project.id);
    if (!detail) {
      setView({ kind: "no-project" });
      return;
    }
    setView({ kind: "loaded", detail });
  } catch (err) {
    setView({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function getSettings(): Promise<Settings | null> {
  const r = await sendMessage({ kind: "settings/get" });
  if (r?.kind === "settings/get") return r.settings;
  return null;
}

async function getActiveDocId(): Promise<string | null> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url) return null;
  return parseDocIdFromUrl(tab.url);
}

async function fetchDocState(docId: string): Promise<DocState | null> {
  const r = await sendMessage({ kind: "doc/state", docId });
  if (r?.kind !== "doc/state") return null;
  if (r.error) throw new Error(r.error);
  return r.state;
}

async function fetchProjectDetail(projectId: string): Promise<ProjectDetail | null> {
  const r = await sendMessage({ kind: "project/detail", projectId });
  if (r?.kind !== "project/detail") return null;
  if (r.error) throw new Error(r.error);
  return r.detail;
}
