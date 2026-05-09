import { ext } from "../shared/browser.ts";
import type { Message, MessageResponse } from "../shared/messages.ts";
import { parseDocIdFromUrl } from "../content/ids.ts";
import { getDocTitle } from "../shared/storage.ts";

const conn = document.getElementById("connection") as HTMLParagraphElement;
const queue = document.getElementById("queue") as HTMLElement;
const lastError = document.getElementById("last-error") as HTMLElement;
const flushBtn = document.getElementById("flush") as HTMLButtonElement;
const openOptions = document.getElementById("open-options") as HTMLButtonElement;
const trackRow = document.getElementById("track-row") as HTMLDivElement;
const trackBtn = document.getElementById("track") as HTMLButtonElement;
const trackLabel = document.getElementById("track-label") as HTMLParagraphElement;

void refresh();

flushBtn.addEventListener("click", async () => {
  flushBtn.disabled = true;
  try {
    await ext.runtime.sendMessage({ kind: "queue/flush" } satisfies Message);
    await refresh();
  } finally {
    flushBtn.disabled = false;
  }
});

openOptions.addEventListener("click", () => {
  ext.runtime.openOptionsPage();
});

async function refresh(): Promise<void> {
  const settings = (await ext.runtime.sendMessage({
    kind: "settings/get",
  } satisfies Message)) as MessageResponse | undefined;

  const haveSettings = settings?.kind === "settings/get" && settings.settings;
  if (haveSettings) {
    conn.textContent = `Connected to ${settings!.settings!.backendUrl}`;
    conn.dataset.tone = "ok";
  } else {
    conn.textContent = "No backend configured — open Options.";
    conn.dataset.tone = "error";
  }

  await renderTrackButton(haveSettings ? settings!.settings! : null);

  const peek = (await ext.runtime.sendMessage({
    kind: "queue/peek",
  } satisfies Message)) as MessageResponse | undefined;
  if (peek?.kind === "queue/peek") {
    queue.textContent = String(peek.queueSize);
    lastError.textContent = peek.lastError ?? "—";
  }
}

/**
 * Show a "Track this doc" button when the active tab is a Google Doc and we
 * have settings saved. The button opens the backend's `/picker` page with
 * the token in `location.hash` (avoiding server-side logging) and the open
 * doc's id+title as hints so the Picker can surface it at the top.
 *
 * Title source: the content script scrapes the real doc name out of the
 * Docs DOM into chrome.storage.local. We read from there rather than
 * `tab.title` because the tab title carries a localized " - Google Docs"
 * suffix that breaks Picker's token-AND name matching for non-English
 * locales (and even for English; the suffix tokens never appear in any
 * file name).
 *
 * Permissions note: the popup reads `tab.url` without the `tabs` permission
 * because the manifest declares
 * `host_permissions: ["https://docs.google.com/*"]`. Tabs whose URL doesn't
 * match are returned with that field stripped, which is what we want.
 */
async function renderTrackButton(
  settings: { backendUrl: string; apiToken: string } | null,
): Promise<void> {
  if (!settings) {
    trackRow.hidden = true;
    return;
  }
  const tab = await getActiveDocTab();
  if (!tab) {
    trackRow.hidden = true;
    return;
  }
  trackRow.hidden = false;
  const display = tab.title || "Google Doc";
  trackLabel.textContent = display;
  trackLabel.title = display;

  trackBtn.onclick = () => {
    const params = new URLSearchParams({
      token: settings.apiToken,
      suggestedDocId: tab.docId,
    });
    // Best-effort: only pass a query when the content script has recorded
    // the doc name. On the very first popup-open after install, the user
    // may click before the scan fires; the user can still browse manually.
    if (tab.title) params.set("suggestedTitle", tab.title);
    const base = settings.backendUrl.replace(/\/+$/, "");
    const url = `${base}/picker#${params.toString()}`;
    void ext.tabs.create({ url });
    window.close();
  };
}

interface ActiveDocTab {
  docId: string;
  /** Real doc name read from the Docs DOM; "" if not yet scraped. */
  title: string;
}

async function getActiveDocTab(): Promise<ActiveDocTab | null> {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url) return null;
  const docId = parseDocIdFromUrl(tab.url);
  if (!docId) return null;
  const title = (await getDocTitle(docId)) ?? "";
  return { docId, title };
}
