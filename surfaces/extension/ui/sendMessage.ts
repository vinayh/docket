import { browser } from "wxt/browser";
import type { Message, MessageResponse } from "../utils/messages.ts";
import type { Settings } from "../utils/types.ts";

/**
 * Typed wrapper over `browser.runtime.sendMessage` for Preact surfaces
 * (popup, side panel). Centralizes the cast so each call site doesn't
 * repeat it.
 */
export function sendMessage(msg: Message): Promise<MessageResponse | undefined> {
  return browser.runtime.sendMessage(msg) as Promise<MessageResponse | undefined>;
}

/**
 * Convenience wrapper used by popup + side-panel surfaces. Returns null
 * when settings aren't configured or the SW reports an error; callers
 * branch on null rather than catching.
 */
export async function getSettings(): Promise<Settings | null> {
  const r = await sendMessage({ kind: "settings/get" });
  if (r?.kind === "settings/get") return r.settings;
  return null;
}

/**
 * Returns both the resolved-and-signed-in `settings` (or null if either
 * field is missing) and the raw `backendUrl` from storage. The popup needs
 * `backendUrl` separately to distinguish the "configured but not signed in"
 * state from "nothing configured" and surface a sign-in CTA inline.
 */
export async function getSettingsStatus(): Promise<{
  settings: Settings | null;
  backendUrl: string | null;
}> {
  const r = await sendMessage({ kind: "settings/get" });
  if (r?.kind === "settings/get") {
    return { settings: r.settings, backendUrl: r.backendUrl };
  }
  return { settings: null, backendUrl: null };
}
