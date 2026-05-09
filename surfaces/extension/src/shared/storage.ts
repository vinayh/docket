import { ext } from "./browser.ts";
import type { CaptureInput, Settings } from "./types.ts";

/**
 * Typed wrappers around `chrome.storage.local`. We pick `local` (not `sync`)
 * because the queue can grow to thousands of entries during outages and
 * `sync` has a hard 100 KB / item-count limit. Settings stay in `local` too —
 * a token is sensitive and shouldn't sync to other devices implicitly.
 */
const KEY_SETTINGS = "settings";
const KEY_QUEUE = "captureQueueV2";
const KEY_SEEN = "seenIds";
const KEY_LAST_ERROR = "lastError";

const SEEN_LIMIT_PER_DOC = 5_000;
/** Hard cap on queued captures. Past this, the oldest items get dropped. */
export const QUEUE_CAP = 5_000;
/** Max attempts per item before we drop it. Protects against poisoned heads. */
export const MAX_ATTEMPTS = 50;

interface SeenIdMap {
  [docId: string]: string[];
}

/**
 * A capture in flight. The `capture` field is what we POST; `attempts` and
 * `firstQueuedAt` are SW-internal bookkeeping that never crosses the wire.
 */
export interface QueuedCapture {
  capture: CaptureInput;
  attempts: number;
  firstQueuedAt: number;
}

async function get<T>(key: string): Promise<T | undefined> {
  const out = await ext.storage.local.get(key);
  return out[key] as T | undefined;
}

async function set<T>(key: string, value: T): Promise<void> {
  await ext.storage.local.set({ [key]: value });
}

export async function getSettings(): Promise<Settings | null> {
  const s = await get<Settings>(KEY_SETTINGS);
  if (!s || !s.backendUrl || !s.apiToken) return null;
  return s;
}

export async function setSettings(s: Settings): Promise<void> {
  await set(KEY_SETTINGS, s);
}

export async function getQueue(): Promise<QueuedCapture[]> {
  const raw = await get<unknown>(KEY_QUEUE);
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is QueuedCapture => isQueuedCapture(x));
}

function isQueuedCapture(x: unknown): x is QueuedCapture {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.capture === "object" &&
    typeof o.attempts === "number" &&
    typeof o.firstQueuedAt === "number"
  );
}

/**
 * Persist the queue. Catches QuotaExceededError from chrome.storage.local
 * (typical when the queue + seen-set + settings cross the 10 MB extension
 * quota) and retries after evicting the oldest half. If even that fails,
 * surfaces the error and clears the queue rather than failing forever.
 */
export async function setQueue(q: QueuedCapture[]): Promise<void> {
  try {
    await set(KEY_QUEUE, q);
  } catch (err) {
    if (!isQuotaExceeded(err)) throw err;
    const half = q.slice(Math.floor(q.length / 2));
    console.warn(
      `[docket] storage quota exceeded with ${q.length} queued; dropping ${q.length - half.length} oldest`,
    );
    try {
      await set(KEY_QUEUE, half);
      await setLastError(
        `storage quota exceeded — dropped ${q.length - half.length} oldest captures`,
      );
    } catch (err2) {
      console.error("[docket] queue persist failed twice; clearing", err2);
      await set(KEY_QUEUE, []);
      await setLastError("storage quota exceeded — queue cleared");
    }
  }
}

function isQuotaExceeded(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /QUOTA|quota/i.test(message);
}

/**
 * Append new captures, then enforce QUEUE_CAP by dropping the oldest items.
 * Returns the post-trim queue length. Capping at insertion time means a
 * misbehaving content script can't blow up storage even if the SW never
 * gets a chance to flush.
 */
export async function appendToQueue(items: CaptureInput[]): Promise<number> {
  const now = Date.now();
  const wrapped: QueuedCapture[] = items.map((capture) => ({
    capture,
    attempts: 0,
    firstQueuedAt: now,
  }));
  const existing = await getQueue();
  let next = [...existing, ...wrapped];
  if (next.length > QUEUE_CAP) {
    const dropped = next.length - QUEUE_CAP;
    next = next.slice(dropped);
    console.warn(`[docket] queue cap (${QUEUE_CAP}) hit; dropped ${dropped} oldest`);
    await setLastError(`queue cap reached — dropped ${dropped} oldest captures`);
  }
  await setQueue(next);
  return next.length;
}

export async function getSeenIds(): Promise<SeenIdMap> {
  return (await get<SeenIdMap>(KEY_SEEN)) ?? {};
}

export async function markSeen(docId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const map = await getSeenIds();
  const current = map[docId] ?? [];
  const merged = [...current, ...ids];
  // Trim oldest entries — bounded memory per doc.
  map[docId] = merged.slice(-SEEN_LIMIT_PER_DOC);
  await set(KEY_SEEN, map);
}

export async function filterUnseen(
  docId: string,
  candidates: { externalId: string }[],
): Promise<{ externalId: string }[]> {
  const map = await getSeenIds();
  const seen = new Set(map[docId] ?? []);
  return candidates.filter((c) => !seen.has(c.externalId));
}

export async function setLastError(message: string | null): Promise<void> {
  await set(KEY_LAST_ERROR, message);
}

export async function getLastError(): Promise<string | null> {
  return (await get<string | null>(KEY_LAST_ERROR)) ?? null;
}
