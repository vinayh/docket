import { browser } from "wxt/browser";
import type { Settings } from "./types.ts";

/**
 * Typed wrappers around `chrome.storage.local`. We pick `local` (not `sync`)
 * because a token is sensitive and shouldn't sync to other devices implicitly.
 *
 * Pre-docx-ingest, this module also owned a capture queue, a per-doc seen-id
 * cache, last-error, and a doc-title cache populated by the content script.
 * The docx-export ingest (SPEC §9.8) recovers the same data server-side, so
 * the entire capture pipeline is gone — leaving just settings here.
 */
const KEY_SETTINGS = "settings";

async function get<T>(key: string): Promise<T | undefined> {
  const out = await browser.storage.local.get(key);
  return out[key] as T | undefined;
}

async function set<T>(key: string, value: T): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

export async function getSettings(): Promise<Settings | null> {
  const s = await get<Settings>(KEY_SETTINGS);
  if (!s || !s.backendUrl || !s.sessionToken) return null;
  return s;
}

export async function setSettings(s: Settings): Promise<void> {
  await set(KEY_SETTINGS, s);
}

/**
 * Partial-update of the persisted settings. Used by the SW's sign-in /
 * sign-out flow to flip `sessionToken` without disturbing `backendUrl`,
 * and by the Options page to update the URL without losing the session.
 */
export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const current = (await get<Settings>(KEY_SETTINGS)) ?? {
    backendUrl: "",
    sessionToken: "",
  };
  await set(KEY_SETTINGS, { ...current, ...patch });
}
