import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import type { Message } from "../../utils/messages.ts";
import { parseDocIdFromUrl } from "../../utils/ids.ts";
import { buildCaptures, scrapeThreads } from "./sidebar-scraper.ts";
import { setDocTitle } from "../../utils/storage.ts";

/**
 * Content script entry. Runs on `https://docs.google.com/document/*`. Watches
 * the discussion sidebar via MutationObserver, scrapes new replies on
 * suggestion threads, and forwards them to the service worker for queueing.
 *
 * MutationObserver guidance:
 *  - Observe a wide subtree (whole `body`) but **debounce** scans heavily —
 *    Docs mutates the DOM on every keystroke. 750ms is enough to absorb a
 *    suggestion-edit burst without stalling first capture for too long.
 *  - Skip work entirely if we can't parse a docId or aren't in the editor.
 */

const DEBOUNCE_MS = 750;
const SEEN_LOCAL_LIMIT = 5_000;

export default defineContentScript({
  matches: ["https://docs.google.com/document/*"],
  runAt: "document_idle",
  allFrames: false,
  main() {
    const docId = parseDocIdFromUrl(location.href);
    if (!docId) return;
    console.log(`[docket] content script ready (doc=${docId})`);
    bootstrap(docId);
  },
});

// Once-per-page-load summary so the user can confirm the scraper found
// something even when no replies survive the suggestion-only filter.
let summaryLogged = false;

function bootstrap(currentDocId: string): void {
  const localSeen = new Set<string>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleScan = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void recordDocName(currentDocId);
      void scan(currentDocId, localSeen);
    }, DEBOUNCE_MS);
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial pass — sidebar may already be open at content-script-load time.
  scheduleScan();
}

/**
 * Read the actual doc name from the Docs DOM and stash it in
 * chrome.storage.local. The popup uses this for the Picker query because
 * the tab/window title is locale-suffixed with " - Google Docs" (or its
 * translation), which breaks Picker's token-AND name matching.
 *
 * Selectors are listed newest-first per the AGENTS.md DOM-selector
 * contract — Docs reships ~quarterly, so we keep older selectors as
 * fallbacks.
 */
const DOC_NAME_SELECTORS: readonly string[] = [
  "input.docs-title-input-input",
  "input.docs-title-input",
  ".docs-title-input-input",
  ".docs-title-input",
];

function readDocNameFromDom(): string | null {
  for (const sel of DOC_NAME_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const value =
      (el as HTMLInputElement).value ??
      (el as HTMLElement).getAttribute("value") ??
      el.textContent ??
      "";
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

async function recordDocName(currentDocId: string): Promise<void> {
  const name = readDocNameFromDom();
  if (!name) return;
  try {
    await setDocTitle(currentDocId, name);
  } catch (err) {
    // Best-effort: a storage write failure shouldn't break capture.
    console.warn("[docket] doc-title persist failed:", err);
  }
}

async function scan(currentDocId: string, localSeen: Set<string>): Promise<void> {
  const threads = scrapeThreads(document);
  if (threads.length === 0) return;
  const captures = await buildCaptures(currentDocId, threads);
  const fresh = captures.filter((c) => !localSeen.has(c.externalId));
  if (!summaryLogged) {
    const sugg = threads.filter((t) => t.isSuggestion).length;
    console.log(
      `[docket] first scan: threads=${threads.length} suggestions=${sugg} captures=${captures.length} fresh=${fresh.length}`,
    );
    summaryLogged = true;
  }
  if (fresh.length === 0) return;

  for (const c of fresh) localSeen.add(c.externalId);
  if (localSeen.size > SEEN_LOCAL_LIMIT) {
    // Drop oldest half — Set iteration order is insertion order.
    const drop = Array.from(localSeen).slice(0, Math.floor(localSeen.size / 2));
    for (const id of drop) localSeen.delete(id);
  }

  const msg: Message = { kind: "capture/submit", captures: fresh };
  try {
    await browser.runtime.sendMessage(msg);
  } catch (err) {
    // SW may be inactive; it'll wake on next message. Re-queueing is the
    // SW's job (it persists to chrome.storage), so we don't retry here.
    console.warn("[docket] sendMessage failed:", err);
  }
}
