import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import * as v from "valibot";
import { MessageSchema, type Message, type MessageResponse } from "../utils/messages.ts";
import { parseDocIdFromUrl } from "../utils/ids.ts";
import { getBackendUrl, getSettings, patchSettings, setSettings } from "../utils/storage.ts";
import { openDashboard, openOptions } from "../utils/ui-surfaces.ts";
import {
  BROWSER_QUIRKS_STORAGE_KEY,
  detectNativeSidebarSupport,
  getBrowserQuirks,
} from "../utils/browser-detect.ts";
import {
  createReviewRequest,
  createVersion,
  fetchDocState,
  fetchProjectDetail,
  fetchVersionComments,
  fetchVersionDiff,
  listProjects,
  loadProjectSettings,
  registerDoc,
  runCommentAction,
  runDocSync,
  signOutFromBackend,
  updateProjectSettings,
} from "../utils/backend-client.ts";

// MV3 service worker. Routes popup / side-panel messages to the backend and accepts the
// tab-based OAuth bridge handoff. Only state held is settings; safe to cold-start any time.

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(
    (raw: unknown, _sender, sendResponse: (r: MessageResponse) => void) => {
      const parsed = v.safeParse(MessageSchema, raw);
      if (!parsed.success) {
        const issue = parsed.issues[0];
        const path = issue.path?.map((p) => String(p.key)).join(".") ?? "";
        const detail = path ? `${path}: ${issue.message}` : issue.message;
        console.warn("[margin] rejected malformed runtime message:", detail);
        sendResponse(errorResponseFor(raw, `invalid message: ${detail}`));
        return false;
      }
      const message = parsed.output;
      void handleMessage(message)
        .then(sendResponse)
        .catch((err) => {
          console.error("[margin] message handler:", err);
          const msg = err instanceof Error ? err.message : String(err);
          // Echo the original kind so callers see the error on the discriminant they awaited.
          sendResponse(errorResponseFor(message, msg));
        });
      return true; // keep the message channel open for the async response
    },
  );

  // OAuth bridge, Chromium path: bridge page calls chrome.runtime.sendMessage from page context.
  // We allow-list on backend origin. Firefox can't reach this listener (Bugzilla 1319168);
  // see the tabs.onUpdated handler below for its fragment fallback.
  browser.runtime.onMessageExternal.addListener(
    (msg, sender, sendResponse: (r: { ok: boolean; error?: string }) => void) => {
      void handleExternal(msg, sender)
        .then(sendResponse)
        .catch((err) => {
          console.error("[margin] external message handler:", err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    },
  );

  // OAuth bridge fragment fallback. Gate on origin + pathname so a token in some unrelated
  // tab's fragment never lands in settings.sessionToken.
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url ?? tab.url;
    if (!url) return;
    void handleAuthFragment(tabId, url);
  });

  // Toolbar routing: per-tab `action.setPopup({ popup: "" })` makes onClicked fire (→ side panel)
  // for tracked Docs; everything else keeps the default popup.
  browser.tabs.onActivated.addListener((info) => {
    void browser.tabs
      .get(info.tabId)
      .then((tab) => evaluateAction(info.tabId, tab.url))
      .catch(() => {
        // Tab gone between activation and get — not actionable.
      });
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      void evaluateAction(tabId, tab.url);
    }
  });

  // Toggle the native sidebar synchronously inside the click handler — sidePanel.open/close and
  // sidebarAction.open/close all reject if the user gesture is lost across an await. The
  // detached-window path the helper falls through to has no gesture requirement, and its
  // repeat-click behavior (focus-existing) is handled inside the helper itself.
  browser.action.onClicked.addListener((tab) => {
    if (!tab || tab.id === undefined) return;
    const windowId = tab.windowId;
    if (windowId !== undefined && panelOpenWindowIds.has(windowId)) {
      closeSidePanelForWindow(windowId);
      return;
    }
    openDashboardForTab(tab);
  });

  // Sign-in/sign-out can change every doc's tracked state; invalidate and re-eval. A change to
  // browser-quirks (detection landed from a page context) flips whether we use the native sidebar
  // vs a detached window, so re-prime the cache and re-evaluate per-tab routing.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.settings && !changes[BROWSER_QUIRKS_STORAGE_KEY]) return;
    trackedCache.clear();
    void primeSidebarCache();
    void refreshAllDocTabs();
  });

  // Auto-open Options on first install. Some Chromium derivatives (Arc) don't render the
  // browser-action popup until the extension is set up, and `runtime.openOptionsPage()`
  // doesn't always work in them either — so we go straight to a tab via `openOptions()`.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") return;
    void openOptions().catch((err) => {
      console.warn("[margin] could not auto-open Options on install:", err);
    });
  });

  // Cold-start sweep so the first toolbar click on pre-existing Doc tabs routes correctly.
  void primeSidebarCache();
  void refreshAllDocTabs();

  // Per-window side-panel open tracking. The panel opens a long-lived port on
  // mount; the port's disconnection event fires when the panel is closed
  // (user closes it, navigates away, or the window goes away). We can't await
  // a query inside `action.onClicked` without losing the user-gesture chain
  // that Chrome's `sidePanel.open/close` requires, so the open-state has to
  // be cached synchronously here.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_LIFECYCLE_PORT) return;
    let windowId: number | undefined;
    const onPortMessage = (msg: unknown): void => {
      if (
        msg &&
        typeof msg === "object" &&
        "kind" in msg &&
        (msg as { kind: unknown }).kind === "panel/hello" &&
        typeof (msg as { windowId?: unknown }).windowId === "number"
      ) {
        windowId = (msg as { windowId: number }).windowId;
        panelOpenWindowIds.add(windowId);
      }
    };
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port.onMessage.removeListener(onPortMessage);
      if (windowId !== undefined) panelOpenWindowIds.delete(windowId);
    });
  });
});

// ---- toolbar-icon routing ------------------------------------------------

const DEFAULT_POPUP_PATH = "popup.html";
const TRACKED_CACHE_TTL_MS = 60_000;
const trackedCache = new Map<string, { tracked: boolean; ts: number }>();
// Shared with the side panel; renaming requires updating the panel's connect() call too.
const PANEL_LIFECYCLE_PORT = "margin-panel-lifecycle";
const panelOpenWindowIds = new Set<number>();

async function isDocTracked(docId: string): Promise<boolean> {
  const hit = trackedCache.get(docId);
  if (hit && Date.now() - hit.ts < TRACKED_CACHE_TTL_MS) return hit.tracked;
  let tracked = false;
  try {
    const state = await fetchDocState(docId);
    tracked = !!(state && state.tracked);
  } catch (err) {
    console.warn("[margin] doc-state lookup failed:", err);
  }
  trackedCache.set(docId, { tracked, ts: Date.now() });
  return tracked;
}

async function evaluateAction(tabId: number, url: string | undefined): Promise<void> {
  const docId = url ? parseDocIdFromUrl(url) : null;
  if (!docId) {
    await safeSetPopup(tabId, DEFAULT_POPUP_PATH);
    return;
  }
  // Don't probe when signed out — and don't cache the resulting "untracked", since the answer
  // flips on sign-in and we'd be stuck with stale entries until the TTL expires.
  const settings = await getSettings();
  if (!settings) {
    await safeSetPopup(tabId, DEFAULT_POPUP_PATH);
    return;
  }
  const tracked = await isDocTracked(docId);
  await safeSetPopup(tabId, tracked ? "" : DEFAULT_POPUP_PATH);
}

async function safeSetPopup(tabId: number, popup: string): Promise<void> {
  try {
    await browser.action.setPopup({ tabId, popup });
  } catch (err) {
    // Tab closed between lookup and set; not actionable.
    console.warn("[margin] action.setPopup failed:", err);
  }
}

async function refreshAllDocTabs(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ url: "https://docs.google.com/*" });
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id === undefined) return Promise.resolve();
        return evaluateAction(tab.id, tab.url);
      }),
    );
  } catch (err) {
    console.warn("[margin] refreshAllDocTabs failed:", err);
  }
}

async function refreshTabsForDoc(docId: string): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ url: "https://docs.google.com/*" });
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id === undefined || !tab.url) return Promise.resolve();
        if (parseDocIdFromUrl(tab.url) !== docId) return Promise.resolve();
        return evaluateAction(tab.id, tab.url);
      }),
    );
  } catch (err) {
    console.warn("[margin] refreshTabsForDoc failed:", err);
  }
}

// Cached so action.onClicked can dispatch synchronously: sidePanel.open must run
// inside the user gesture, and any `await` before that call drops the gesture.
// Default is the SW's UA-only detection (no DOM here for the Arc CSS-vars
// check); a page-context detection later overrides via storage onChanged.
let cachedUseNativeSidebar: boolean = detectNativeSidebarSupport();

async function primeSidebarCache(): Promise<void> {
  const quirks = await getBrowserQuirks();
  cachedUseNativeSidebar = quirks
    ? quirks.nativeSidebarSupported
    : detectNativeSidebarSupport();
}

function openDashboardForTab(tab: chrome.tabs.Tab): void {
  // Don't await — sidePanel.open inside the helper has to stay synchronous
  // within the user-gesture chain. The windows.create fallback has no
  // gesture requirement, so settling later is fine for that path.
  void openDashboard({
    useNativeSidebar: cachedUseNativeSidebar,
    windowId: tab.windowId,
    tabId: tab.id,
  }).catch((err) => {
    console.warn("[margin] openDashboard failed:", err);
  });
}

function closeSidePanelForWindow(windowId: number): void {
  // Counterpart of the panel-open path inside openDashboard. Chrome's
  // `sidePanel.close` is 116+; Firefox's `sidebarAction.close` has been around
  // since 57. Drop the cached open-state optimistically so a third click
  // reopens reliably even if the close call lost its gesture window.
  panelOpenWindowIds.delete(windowId);
  const api = browser as unknown as {
    sidePanel?: { close: (opts: { windowId: number }) => Promise<void> };
    sidebarAction?: { close: () => Promise<void> };
  };
  if (api.sidePanel?.close) {
    api.sidePanel.close({ windowId }).catch((err) => {
      console.warn("[margin] sidePanel.close failed:", err);
    });
    return;
  }
  if (api.sidebarAction?.close) {
    api.sidebarAction.close().catch((err) => {
      console.warn("[margin] sidebarAction.close failed:", err);
    });
  }
}

interface ExternalAuthMessage {
  kind: "auth/token";
  token: string;
}

function isExternalAuthMessage(msg: unknown): msg is ExternalAuthMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { kind?: unknown; token?: unknown };
  return m.kind === "auth/token" && typeof m.token === "string" && m.token.length > 0;
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function handleExternal(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; error?: string }> {
  if (!isExternalAuthMessage(msg)) {
    return { ok: false, error: "unsupported message" };
  }
  const expected = originOf(await getBackendUrl());
  const actual = originOf(sender.origin ?? sender.url);
  if (!expected || !actual || expected !== actual) {
    // Don't echo the expected origin back — keep the rejection opaque.
    console.warn(
      "[margin] rejected external auth/token from",
      actual ?? "unknown sender",
    );
    return { ok: false, error: "origin not allowed" };
  }
  await patchSettings({ sessionToken: msg.token });
  return { ok: true };
}

// Firefox fragment-fallback companion to handleExternal. tab.url requires the tabs permission
// or matching host permissions — the Options page's permissions.request flow grants the
// backend origin, so by the time this fires the URL is visible.
async function handleAuthFragment(tabId: number, url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!parsed.hash || parsed.hash.length < 2) return;
  if (parsed.pathname !== "/api/auth/ext/success") return;

  const backendOrigin = originOf(await getBackendUrl());
  if (!backendOrigin || backendOrigin !== parsed.origin) return;

  const params = new URLSearchParams(parsed.hash.slice(1));
  const token = params.get("token");
  if (!token) return;

  await patchSettings({ sessionToken: token });
  try {
    await browser.tabs.remove(tabId);
  } catch (err) {
    console.warn("[margin] could not close auth bridge tab:", err);
  }
}

function errorResponseFor(message: Message | unknown, error: string): MessageResponse {
  const kind =
    typeof message === "object" && message !== null && "kind" in message
      ? (message as { kind: unknown }).kind
      : null;
  switch (kind) {
    case "settings/get":
      return { kind: "settings/get", settings: null, backendUrl: null, error };
    case "settings/set":
      return { kind: "settings/set", ok: true, error };
    case "auth/sign-out":
      return { kind: "auth/sign-out", ok: true, error };
    case "doc/state":
      return { kind: "doc/state", state: null, error };
    case "doc/sync":
      return { kind: "doc/sync", state: null, error };
    case "doc/register":
      return { kind: "doc/register", result: { kind: "error", message: error }, error };
    case "project/detail":
      return { kind: "project/detail", detail: null, error };
    case "projects/list":
      return { kind: "projects/list", projects: null, error };
    case "version/create":
      return { kind: "version/create", result: null, error };
    case "version/diff":
      return { kind: "version/diff", payload: null, error };
    case "version/comments":
      return { kind: "version/comments", payload: null, error };
    case "comment/action":
      return { kind: "comment/action", result: null, error };
    case "settings/load":
      return { kind: "settings/load", settings: null, error };
    case "settings/update":
      return { kind: "settings/update", settings: null, error };
    case "review/request":
      return { kind: "review/request", result: null, error };
    default:
      // Unknown inbound kind; caller bails on `error`, the discriminant doesn't matter.
      return { kind: "settings/get", settings: null, backendUrl: null, error };
  }
}

async function handleMessage(message: Message): Promise<MessageResponse> {
  switch (message.kind) {
    case "settings/get": {
      const [settings, backendUrl] = await Promise.all([
        getSettings(),
        getBackendUrl(),
      ]);
      return { kind: "settings/get", settings, backendUrl };
    }
    case "settings/set": {
      await setSettings(message.settings);
      return { kind: "settings/set", ok: true };
    }
    case "auth/sign-out": {
      await signOutFromBackend();
      return { kind: "auth/sign-out", ok: true };
    }
    case "doc/state": {
      const state = await fetchDocState(message.docId);
      // Piggyback on the popup's own state queries to keep the toolbar cache fresh — the picker
      // page registers docs out-of-band, so this is when the SW first learns a new tracking.
      const tracked = !!(state && state.tracked);
      const prev = trackedCache.get(message.docId);
      trackedCache.set(message.docId, { tracked, ts: Date.now() });
      if (!prev || prev.tracked !== tracked) {
        void refreshTabsForDoc(message.docId);
      }
      return { kind: "doc/state", state };
    }
    case "doc/sync": {
      const state = await runDocSync(message.docId);
      trackedCache.set(message.docId, {
        tracked: !!(state && state.tracked),
        ts: Date.now(),
      });
      void refreshTabsForDoc(message.docId);
      return { kind: "doc/sync", state };
    }
    case "doc/register": {
      const result = await registerDoc(message.docUrlOrId);
      // The popup path no longer hits this (picker POSTs register-doc directly); kept for future surfaces.
      if (result.kind === "registered") {
        trackedCache.delete(result.parentDocId);
        void refreshTabsForDoc(result.parentDocId);
      }
      return { kind: "doc/register", result };
    }
    case "project/detail": {
      const detail = await fetchProjectDetail(message.projectId);
      return { kind: "project/detail", detail };
    }
    case "projects/list": {
      const projects = await listProjects();
      return { kind: "projects/list", projects };
    }
    case "version/create": {
      const result = await createVersion({
        projectId: message.projectId,
        label: message.label,
      });
      return { kind: "version/create", result };
    }
    case "version/diff": {
      const payload = await fetchVersionDiff(
        message.fromVersionId,
        message.toVersionId,
      );
      return { kind: "version/diff", payload };
    }
    case "version/comments": {
      const payload = await fetchVersionComments(message.versionId);
      return { kind: "version/comments", payload };
    }
    case "comment/action": {
      const result = await runCommentAction({
        canonicalCommentId: message.canonicalCommentId,
        action: message.action,
        targetVersionId: message.targetVersionId,
      });
      return { kind: "comment/action", result };
    }
    case "settings/load": {
      const settings = await loadProjectSettings(message.projectId);
      return { kind: "settings/load", settings };
    }
    case "settings/update": {
      const settings = await updateProjectSettings(message.projectId, message.patch);
      return { kind: "settings/update", settings };
    }
    case "review/request": {
      const result = await createReviewRequest({
        versionId: message.versionId,
        assigneeEmails: message.assigneeEmails,
        deadline: message.deadline,
      });
      return { kind: "review/request", result };
    }
  }
}
