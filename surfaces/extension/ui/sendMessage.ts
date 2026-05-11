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
