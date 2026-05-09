import { ext } from "../shared/browser.ts";
import type { Message } from "../shared/messages.ts";
import { parseDocIdFromUrl } from "./ids.ts";
import { buildCaptures, scrapeThreads } from "./sidebar-scraper.ts";

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

const docId = parseDocIdFromUrl(location.href);
if (docId) {
  console.log(`[docket] content script ready (doc=${docId})`);
  bootstrap(docId);
}

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
      void scan(currentDocId, localSeen);
    }, DEBOUNCE_MS);
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial pass — sidebar may already be open at content-script-load time.
  scheduleScan();
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
    await ext.runtime.sendMessage(msg);
  } catch (err) {
    // SW may be inactive; it'll wake on next message. Re-queueing is the
    // SW's job (it persists to chrome.storage), so we don't retry here.
    console.warn("[docket] sendMessage failed:", err);
  }
}
