import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import type { Message, MessageResponse } from "../utils/messages.ts";
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
} from "../utils/storage.ts";
import type {
  CaptureInput,
  CaptureResult,
  DocState,
  IngestCapturesResult,
  PickerConfig,
  ProjectDetail,
  RegisterDocResult,
  Settings,
  VersionDiffPayload,
} from "../utils/types.ts";

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

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
      void handleMessage(message)
        .then(sendResponse)
        .catch((err) => {
          console.error("[docket] message handler:", err);
          const msg = err instanceof Error ? err.message : String(err);
          // Echo the original kind so callers route the error to the same
          // discriminant arm they were waiting on.
          sendResponse(errorResponseFor(message, msg));
        });
      return true; // keep the message channel open for the async response
    },
  );

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FLUSH_ALARM) void flushQueue();
  });

  browser.runtime.onStartup.addListener(() => {
    void ensureFlushAlarm();
    void flushQueue();
  });

  browser.runtime.onInstalled.addListener(() => {
    void ensureFlushAlarm();
  });

  // Eagerly start the alarm — the onInstalled listener doesn't fire on plain
  // service-worker spin-ups, only on extension install / update.
  void ensureFlushAlarm();
  void getSeenIds(); // touch storage to confirm permissions early
});

function errorResponseFor(message: Message, error: string): MessageResponse {
  switch (message.kind) {
    case "capture/submit":
      return { kind: "capture/submit", queuedCount: -1, error };
    case "settings/get":
      return { kind: "settings/get", settings: null, error };
    case "settings/set":
      return { kind: "settings/set", ok: true, error };
    case "queue/flush":
      return { kind: "queue/flush", result: { error }, error };
    case "queue/peek":
      return { kind: "queue/peek", queueSize: -1, lastError: error, error };
    case "doc/state":
      return { kind: "doc/state", state: null, error };
    case "doc/sync":
      return { kind: "doc/sync", state: null, error };
    case "doc/register":
      return { kind: "doc/register", result: { kind: "error", message: error }, error };
    case "picker/config":
      return { kind: "picker/config", config: null, error };
    case "project/detail":
      return { kind: "project/detail", detail: null, error };
    case "version/diff":
      return { kind: "version/diff", payload: null, error };
  }
}

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
    case "doc/state": {
      const state = await fetchDocState(message.docId);
      return { kind: "doc/state", state };
    }
    case "doc/sync": {
      const state = await runDocSync(message.docId);
      return { kind: "doc/sync", state };
    }
    case "doc/register": {
      const result = await registerDoc(message.docUrlOrId);
      return { kind: "doc/register", result };
    }
    case "picker/config": {
      const config = await fetchPickerConfig();
      return { kind: "picker/config", config };
    }
    case "project/detail": {
      const detail = await fetchProjectDetail(message.projectId);
      return { kind: "project/detail", detail };
    }
    case "version/diff": {
      const payload = await fetchVersionDiff(
        message.fromVersionId,
        message.toVersionId,
      );
      return { kind: "version/diff", payload };
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
  const existing = await browser.alarms.get(FLUSH_ALARM);
  if (!existing) {
    await browser.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_ALARM_PERIOD_MIN });
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
    await reconcileQueue(head, "batch_failure", null);
    return { error: message };
  }

  // Per-item disposition. inserted / duplicate / orphaned → acked. Everything
  // else stays in the queue with attempts++; once an item exceeds
  // MAX_ATTEMPTS we drop it so a permanently-broken envelope can't poison
  // the head.
  const ackedIdsByDoc = new Map<string, string[]>();
  for (const r of result.results) {
    const item = head.find((h) => h.capture.externalId === r.externalId);
    if (!item) continue;
    if (
      r.status === "inserted" ||
      r.status === "duplicate" ||
      r.status === "orphaned"
    ) {
      const list = ackedIdsByDoc.get(item.capture.docId) ?? [];
      list.push(r.externalId);
      ackedIdsByDoc.set(item.capture.docId, list);
    }
  }

  const dropped = await reconcileQueue(head, "post_flush", result);
  for (const [docId, ids] of ackedIdsByDoc) await markSeen(docId, ids);
  await setLastError(summarizeAfterFlush(result.results, dropped));
  return result;
}

/**
 * Apply per-item flush dispositions back to the queue. Re-reads the queue
 * post-network and rebuilds it by externalId: items in `head` that were
 * acked are dropped, items that failed get attempts++, items not in `head`
 * (newly enqueued during the network round-trip) are preserved.
 *
 * Note: this is not fully race-free. `inflightFlush` serializes
 * flush↔flush, but a concurrent `enqueue` can still interleave its own
 * `getQueue → setQueue` between this function's read and write, in which
 * case the trailing `setQueue` would overwrite the enqueue's append. In
 * practice `chrome.storage.local` operations land sequentially enough that
 * this is rare, but the only durable fix is a single in-memory mutex
 * covering all queue mutations. Acceptable trade-off for now: the loss
 * shows up as a missed capture, which the next scan re-emits.
 *
 * Returns the count of items dropped past MAX_ATTEMPTS so the caller can
 * include it in the user-visible summary.
 */
async function reconcileQueue(
  head: QueuedCapture[],
  reason: string,
  result: IngestCapturesResult | null,
): Promise<number> {
  const headIds = new Set(head.map((h) => h.capture.externalId));
  const headById = new Map(head.map((h) => [h.capture.externalId, h]));

  // Acked items get removed from the queue entirely. Unacked items in head
  // get attempts++ and either re-queued in place or dropped. Items NOT in
  // head (newly-enqueued during the await) are passed through untouched.
  const ackedIds = new Set<string>();
  if (result) {
    for (const r of result.results) {
      if (
        r.status === "inserted" ||
        r.status === "duplicate" ||
        r.status === "orphaned"
      ) {
        ackedIds.add(r.externalId);
      }
    }
  }

  const current = await getQueue();
  let dropped = 0;
  const next: QueuedCapture[] = [];
  for (const item of current) {
    const id = item.capture.externalId;
    if (!headIds.has(id)) {
      // Not in the flushed batch — newly enqueued during the network call.
      next.push(item);
      continue;
    }
    if (ackedIds.has(id)) {
      // Acked → drop.
      continue;
    }
    // In head, not acked → bump attempts (use the head snapshot for the
    // base so two concurrent flushes never compound the bump on the same
    // physical attempt).
    const base = headById.get(id) ?? item;
    const bumped: QueuedCapture = { ...base, attempts: base.attempts + 1 };
    if (bumped.attempts >= MAX_ATTEMPTS) {
      dropped++;
      console.warn(
        `[docket] dropping capture ${id} after ${bumped.attempts} attempts (${reason})`,
      );
      continue;
    }
    next.push(bumped);
  }
  await setQueue(next);
  return dropped;
}

/**
 * Authenticated POST helper. One place for: URL build, auth header,
 * friendly 401/403 message, body-prefix-on-error, JSON parse. Every SW
 * fetch wrapper that authenticates with the user's API token routes
 * through here so a single missing/expired token yields the same prompt
 * everywhere.
 */
async function postJson<T>(
  path: string,
  body: unknown,
  settings: Settings,
): Promise<T> {
  const url = new URL(path, settings.backendUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiToken}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("API token rejected — issue a new one");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function postCaptures(
  settings: Settings,
  captures: CaptureInput[],
): Promise<IngestCapturesResult> {
  return postJson<IngestCapturesResult>(
    "/api/extension/captures",
    { captures },
    settings,
  );
}

/**
 * Routes the popup's "is this doc tracked?" query to the backend's
 * doc-state endpoint. Returns null when settings are missing — the popup
 * renders that as a configuration error rather than an unknown-doc state.
 * Network / auth failures bubble up via the message-handler error path.
 */
async function fetchDocState(docId: string): Promise<DocState | null> {
  const settings = await getSettings();
  if (!settings) return null;
  return postJson<DocState>("/api/extension/doc-state", { docId }, settings);
}

async function runDocSync(docId: string): Promise<DocState | null> {
  const settings = await getSettings();
  if (!settings) return null;
  return postJson<DocState>("/api/extension/doc-sync", { docId }, settings);
}

/**
 * Calls /api/picker/register-doc on the popup's behalf — the sandboxed
 * picker iframe can't reach the backend (null origin), so it postMessages
 * the picked id up to the popup, the popup dispatches here. Maps both 200
 * (created) and 409 already_exists into the same `registered` shape because
 * the popup treats them identically: show "tracked, project <id>".
 */
async function registerDoc(docUrlOrId: string): Promise<RegisterDocResult> {
  const settings = await getSettings();
  if (!settings) return { kind: "error", message: "no settings configured" };
  const url = new URL("/api/picker/register-doc", settings.backendUrl).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiToken}`,
      },
      body: JSON.stringify({ docUrlOrId }),
    });
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const body = (await res.json().catch(() => ({}))) as {
    projectId?: string;
    parentDocId?: string;
    error?: string;
    message?: string;
  };
  if (res.ok && body.projectId && body.parentDocId) {
    return {
      kind: "registered",
      projectId: body.projectId,
      parentDocId: body.parentDocId,
      alreadyExisted: false,
    };
  }
  if (res.status === 409 && body.error === "already_exists" && body.projectId && body.parentDocId) {
    return {
      kind: "registered",
      projectId: body.projectId,
      parentDocId: body.parentDocId,
      alreadyExisted: true,
    };
  }
  if (res.status === 401) {
    return { kind: "error", message: "API token rejected — issue a new one" };
  }
  return {
    kind: "error",
    message: body.message ?? `register-doc failed (${res.status})`,
  };
}

/**
 * Routes the side-panel's project-dashboard query through the SW so the API
 * token never reaches the side-panel origin. Returns null on 404 (missing /
 * not-owner) so the panel can render a "no such project" state without
 * conflating it with network errors.
 */
async function fetchProjectDetail(projectId: string): Promise<ProjectDetail | null> {
  const settings = await getSettings();
  if (!settings) return null;
  const url = new URL("/api/extension/project", settings.backendUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiToken}`,
    },
    body: JSON.stringify({ projectId }),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`project-detail ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as ProjectDetail;
}

async function fetchVersionDiff(
  fromVersionId: string,
  toVersionId: string,
): Promise<VersionDiffPayload | null> {
  const settings = await getSettings();
  if (!settings) return null;
  const url = new URL("/api/extension/version-diff", settings.backendUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiToken}`,
    },
    body: JSON.stringify({ fromVersionId, toVersionId }),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`version-diff ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as VersionDiffPayload;
}

async function fetchPickerConfig(): Promise<PickerConfig | null> {
  const settings = await getSettings();
  if (!settings) return null;
  const url = new URL("/api/picker/config", settings.backendUrl).toString();
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`picker-config ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    clientId: string | null;
    apiKey: string | null;
    projectNumber: string | null;
  };
  if (!body.clientId || !body.apiKey || !body.projectNumber) return null;
  return {
    clientId: body.clientId,
    apiKey: body.apiKey,
    projectNumber: body.projectNumber,
  };
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

