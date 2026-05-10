import { browser } from "wxt/browser";
import type { Message, MessageResponse } from "../utils/messages.ts";

/**
 * Typed wrapper over `browser.runtime.sendMessage` for Preact surfaces
 * (popup, side panel). Centralizes the cast so each call site doesn't
 * repeat it.
 */
export function sendMessage(msg: Message): Promise<MessageResponse | undefined> {
  return browser.runtime.sendMessage(msg) as Promise<MessageResponse | undefined>;
}
