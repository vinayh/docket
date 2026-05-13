import { useEffect, useRef, useState } from "preact/hooks";
import { browser } from "wxt/browser";
import { parseDocIdFromUrl } from "../../utils/ids.ts";
import { Header } from "../../ui/Header.tsx";
import { getSettings, sendMessage } from "../../ui/sendMessage.ts";
import type {
  DocState,
  ProjectDetail,
  ProjectListEntry,
} from "../../utils/types.ts";
import { Comments } from "./views/Comments.tsx";
import { Dashboard } from "./views/Dashboard.tsx";
import { Settings } from "./views/Settings.tsx";
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
  | { kind: "picker"; projects: ProjectListEntry[] }
  | { kind: "loaded"; detail: ProjectDetail }
  | { kind: "diff"; detail: ProjectDetail; fromVersionId: string; toVersionId: string }
  | {
      kind: "comments";
      detail: ProjectDetail;
      versionId: string;
      versionLabel: string;
    }
  | { kind: "settings"; detail: ProjectDetail }
  | { kind: "error"; message: string };

export function App() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const bootTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void boot(setView);

    // Re-resolve when the user navigates the active tab so the panel
    // follows the doc context. `tabs.onUpdated` fires for every change a
    // tab makes — title, favicon, loading state, URL — so we filter to
    // url-changes and coalesce bursts behind a single short debounce.
    // `tabs.onActivated` fires once per tab switch; coalescing handles
    // the case where it lands alongside an onUpdated.
    const schedule = () => {
      if (bootTimer.current) clearTimeout(bootTimer.current);
      bootTimer.current = setTimeout(() => {
        bootTimer.current = null;
        void boot(setView);
      }, 100);
    };
    const onActivated = (): void => schedule();
    const onUpdated = (
      _tabId: number,
      changeInfo: { url?: string; status?: string },
    ): void => {
      // Only re-boot on URL changes or when the tab finishes loading; skip
      // title / favicon / audible / pinned churn.
      if (changeInfo.url || changeInfo.status === "complete") schedule();
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      if (bootTimer.current) clearTimeout(bootTimer.current);
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
    case "picker":
      return (
        <ProjectPicker
          projects={view.projects}
          onPick={async (p) => {
            setView({ kind: "loading" });
            try {
              const detail = await fetchProjectDetail(p.id);
              if (!detail) {
                setView({ kind: "error", message: "project not found" });
                return;
              }
              setView({ kind: "loaded", detail });
            } catch (err) {
              setView({
                kind: "error",
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }}
        />
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
          onOpenComments={(versionId, versionLabel) =>
            setView({
              kind: "comments",
              detail: view.detail,
              versionId,
              versionLabel,
            })
          }
          onOpenSettings={() =>
            setView({ kind: "settings", detail: view.detail })
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
    case "comments":
      return (
        <Comments
          versionId={view.versionId}
          versionLabel={view.versionLabel}
          onClose={() => setView({ kind: "loaded", detail: view.detail })}
        />
      );
    case "settings":
      return (
        <Settings
          projectId={view.detail.project.id}
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

  try {
    const docId = await getActiveDocId();
    if (docId) {
      const state = await fetchDocState(docId);
      if (state && state.tracked) {
        const detail = await fetchProjectDetail(state.project.id);
        if (detail) {
          setView({ kind: "loaded", detail });
          return;
        }
      }
    }
    // Fall through to the project picker when there's no active Docs tab or
    // it isn't tracked. The user can pick from their own projects to navigate
    // the dashboard without needing to alt-tab over to a Docs window first.
    const projects = await fetchProjects();
    setView({ kind: "picker", projects: projects ?? [] });
  } catch (err) {
    setView({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function getActiveDocId(): Promise<string | null> {
  // E2E override: when the panel is opened as a standalone tab
  // (chrome-extension://…/sidepanel.html?activeDocId=…), the active-tab
  // query resolves to the panel tab itself, not the docs tab the test is
  // targeting. The query-string lets the harness inject the doc id
  // directly. Guarded by the `?activeDocId=` presence — production
  // side-panel opens don't pass it.
  const override = new URLSearchParams(window.location.search).get("activeDocId");
  if (override) return parseDocIdFromUrl(override) ?? override;

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

async function fetchProjects(): Promise<ProjectListEntry[] | null> {
  const r = await sendMessage({ kind: "projects/list" });
  if (r?.kind !== "projects/list") return null;
  if (r.error) throw new Error(r.error);
  return r.projects;
}

function ProjectPicker({
  projects,
  onPick,
}: {
  projects: ProjectListEntry[];
  onPick: (p: ProjectListEntry) => void;
}) {
  if (projects.length === 0) {
    return (
      <>
        <p class="title">No projects yet</p>
        <p class="muted">
          Open a Google Doc and use the toolbar popup's "Add to Margin" button
          to track your first doc.
        </p>
      </>
    );
  }
  return (
    <>
      <p class="title">Your projects</p>
      <p class="muted">
        Open a tracked Google Doc to jump straight to its dashboard, or pick
        from your existing projects:
      </p>
      <ul class="project-picker">
        {projects.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onPick(p)}>
              <span class="project-picker-doc">{p.parentDocId}</span>
              <span class="muted"> · added {formatDate(p.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}
