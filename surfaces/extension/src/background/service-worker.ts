import { ext } from "../shared/browser.ts";
import type { Message, MessageResponse } from "../shared/messages.ts";
import {
  appendToQueue,
  filterUnseen,
  getLastError,
  getQueue,
  getSeenIds,
  getSettings,
  markSeen,
  MAX_ATTEMPTS,
  setLastError,
  setQueue,
  setSettings,
  type QueuedCapture,
} from "../shared/storage.ts";
import type {
  CaptureInput,
  CaptureResult,
  IngestCapturesResult,
  Settings,
} from "../shared/types.ts";

/**
 * MV3 service worker. Three concerns:
 *  1. Receive capture batches from the content script and persist them.
 *  2. Flush the queue to the Docket backend, batching + dedup'd against
 *     previously-acknowledged ids.
 *  3. Wake up periodically (chrome.alarms) so an offline-then-online host
 *     drains its queue without needing the user to revisit a Docs tab.
 *
 * The SW is event-driven and gets unloaded aggressively in MV3. All state
 * lives in chrome.storage.local; nothing module-scoped is durable.
 */

const FLUSH_BATCH = 25;
const FLUSH_ALARM = "docket-flush";
const FLUSH_ALARM_PERIOD_MIN = 1; // every minute when there's queued work

ext.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
    void handleMessage(message).then(sendResponse).catch((err) => {
      console.error("[docket] message handler:", err);
      sendResponse({
        kind: "queue/peek",
        queueSize: -1,
        lastError: err instanceof Error ? err.message : String(err),
      });
    });
    return true; // keep the message channel open for the async response
  },
);

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) void flushQueue();
});

ext.runtime.onStartup.addListener(() => {
  void ensureFlushAlarm();
  void flushQueue();
});

ext.runtime.onInstalled.addListener(() => {
  void ensureFlushAlarm();
});

async function handleMessage(message: Message): Promise<MessageResponse> {
  switch (message.kind) {
    case "capture/submit": {
      const queueSize = await enqueue(message.captures);
      void flushQueue(); // fire-and-forget; backpressure handled inside
      return { kind: "capture/submit", queuedCount: queueSize };
    }
    case "settings/get": {
      const settings = await getSettings();
      return { kind: "settings/get", settings };
    }
    case "settings/set": {
      await setSettings(message.settings);
      await setLastError(null);
      void flushQueue();
      return { kind: "settings/set", ok: true };
    }
    case "queue/flush": {
      const result = await flushQueue();
      return { kind: "queue/flush", result };
    }
    case "queue/peek": {
      const queue = await getQueue();
      const lastError = await getLastError();
      return { kind: "queue/peek", queueSize: queue.length, lastError };
    }
  }
}

async function enqueue(captures: CaptureInput[]): Promise<number> {
  if (captures.length === 0) return (await getQueue()).length;

  // Pre-filter against the per-doc seen set so we never queue something the
  // backend has already acked. The content script already filters per-tab,
  // but a fresh tab on the same doc starts with an empty in-memory set.
  const grouped = new Map<string, CaptureInput[]>();
  for (const c of captures) {
    const arr = grouped.get(c.docId) ?? [];
    arr.push(c);
    grouped.set(c.docId, arr);
  }

  const survivors: CaptureInput[] = [];
  for (const [docId, items] of grouped) {
    const unseen = (await filterUnseen(docId, items)) as CaptureInput[];
    survivors.push(...unseen);
  }
  if (survivors.length === 0) return (await getQueue()).length;

  return appendToQueue(survivors);
}

async function ensureFlushAlarm(): Promise<void> {
  const existing = await ext.alarms.get(FLUSH_ALARM);
  if (!existing) {
    await ext.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_ALARM_PERIOD_MIN });
  }
}

let inflightFlush: Promise<IngestCapturesResult | { error: string } | null> | null =
  null;

function flushQueue(): Promise<IngestCapturesResult | { error: string } | null> {
  if (inflightFlush) return inflightFlush;
  inflightFlush = (async () => {
    try {
      return await flushQueueInner();
    } finally {
      inflightFlush = null;
    }
  })();
  return inflightFlush;
}

async function flushQueueInner(): Promise<
  IngestCapturesResult | { error: string } | null
> {
  const queue = await getQueue();
  if (queue.length === 0) return null;

  const settings = await getSettings();
  if (!settings) {
    await setLastError("no backend / token configured — open the options page");
    return { error: "no settings" };
  }

  const head = queue.slice(0, FLUSH_BATCH);
  const tail = queue.slice(FLUSH_BATCH);

  let result: IngestCapturesResult;
  try {
    result = await postCaptures(
      settings,
      head.map((q) => q.capture),
    );
  } catch (err) {
    // Whole-batch failure (network, 5xx, auth). Bump the attempts counter on
    // the head so a poisoned auth state or bad envelope doesn't loop forever.
    const message = err instanceof Error ? err.message : String(err);
    await setLastError(message);
    const survivors = bumpAttempts(head, "batch_failure");
    await setQueue([...survivors, ...tail]);
    return { error: message };
  }

  // Per-item disposition. inserted / duplicate / orphaned → acked. Everything
  // else stays in the queue with attempts++; once an item exceeds
  // MAX_ATTEMPTS we drop it so a permanently-broken envelope can't poison
  // the head.
  const ackedIdsByDoc = new Map<string, string[]>();
  const requeue: QueuedCapture[] = [];
  let dropped = 0;
  const headById = new Map(head.map((q) => [q.capture.externalId, q]));
  for (const r of result.results) {
    const item = headById.get(r.externalId);
    if (!item) continue;
    if (
      r.status === "inserted" ||
      r.status === "duplicate" ||
      r.status === "orphaned"
    ) {
      const list = ackedIdsByDoc.get(item.capture.docId) ?? [];
      list.push(r.externalId);
      ackedIdsByDoc.set(item.capture.docId, list);
    } else {
      const next = { ...item, attempts: item.attempts + 1 };
      if (next.attempts >= MAX_ATTEMPTS) {
        dropped++;
        console.warn(
          `[docket] dropping capture ${r.externalId} after ${next.attempts} attempts (last status: ${r.status}${r.message ? ", " + r.message : ""})`,
        );
        continue;
      }
      requeue.push(next);
    }
  }

  await setQueue([...requeue, ...tail]);
  for (const [docId, ids] of ackedIdsByDoc) await markSeen(docId, ids);
  await setLastError(summarizeAfterFlush(result.results, dropped));
  return result;
}

function bumpAttempts(items: QueuedCapture[], reason: string): QueuedCapture[] {
  const out: QueuedCapture[] = [];
  let dropped = 0;
  for (const item of items) {
    const next = { ...item, attempts: item.attempts + 1 };
    if (next.attempts >= MAX_ATTEMPTS) {
      dropped++;
      console.warn(
        `[docket] dropping capture ${item.capture.externalId} after ${next.attempts} attempts (${reason})`,
      );
      continue;
    }
    out.push(next);
  }
  if (dropped > 0) {
    console.warn(`[docket] ${reason}: dropped ${dropped} captures past retry limit`);
  }
  return out;
}

async function postCaptures(
  settings: Settings,
  captures: CaptureInput[],
): Promise<IngestCapturesResult> {
  const url = new URL("/api/extension/captures", settings.backendUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiToken}`,
    },
    body: JSON.stringify({ captures }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`auth rejected (${res.status}) — check your API token`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`backend ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as IngestCapturesResult;
}

function summarizeAfterFlush(
  results: CaptureResult[],
  dropped: number,
): string | null {
  const errors = results.filter((r) => r.status === "error");
  const parts: string[] = [];
  if (errors.length > 0) {
    const sample = errors[0]!.message ?? "unspecified";
    parts.push(`${errors.length} captures failed (sample: ${sample.slice(0, 120)})`);
  }
  if (dropped > 0) {
    parts.push(`dropped ${dropped} after exceeding retry limit`);
  }
  return parts.length === 0 ? null : parts.join("; ");
}

// Eagerly start the alarm — the onInstalled listener doesn't fire on plain
// service-worker spin-ups, only on extension install / update.
void ensureFlushAlarm();
void getSeenIds(); // touch storage to confirm permissions early
