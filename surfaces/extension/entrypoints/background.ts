import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import * as v from "valibot";
import { MessageSchema, type Message, type MessageResponse } from "../utils/messages.ts";
import { getBackendUrl, getSettings, patchSettings, setSettings } from "../utils/storage.ts";
import {
  fetchDocState,
  fetchProjectDetail,
  fetchVersionComments,
  fetchVersionDiff,
  loadProjectSettings,
  registerDoc,
  runCommentAction,
  runDocSync,
  signOutFromBackend,
  updateProjectSettings,
} from "../utils/backend-client.ts";

/**
 * MV3 service worker. Sole job is routing popup / side-panel messages to the
 * backend (via `utils/backend-client.ts`) and accepting the tab-based OAuth
 * bridge handoff. Pre-docx-ingest the SW also owned a capture queue + flush
 * loop fed by the docs.google.com content script; that pipeline is gone
 * (SPEC §9.8 — backend exports the doc as `.docx` and parses it server-side).
 *
 * State this SW touches: settings only (in chrome.storage.local). No queue,
 * no seen-set, no per-doc cache. The SW can spin up cold on every message
 * without losing anything.
 */

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(
    (raw: unknown, _sender, sendResponse: (r: MessageResponse) => void) => {
      const parsed = v.safeParse(MessageSchema, raw);
      if (!parsed.success) {
        const issue = parsed.issues[0];
        const path = issue.path?.map((p) => String(p.key)).join(".") ?? "";
        const detail = path ? `${path}: ${issue.message}` : issue.message;
        console.warn("[margin] rejected malformed runtime message:", detail);
        sendResponse(errorResponseFor(raw, `invalid message: ${detail}`));
        return false;
      }
      const message = parsed.output;
      void handleMessage(message)
        .then(sendResponse)
        .catch((err) => {
          console.error("[margin] message handler:", err);
          const msg = err instanceof Error ? err.message : String(err);
          // Echo the original kind so callers route the error to the same
          // discriminant arm they were waiting on.
          sendResponse(errorResponseFor(message, msg));
        });
      return true; // keep the message channel open for the async response
    },
  );

  // Tab-based OAuth bridge — Chromium path. The `/api/auth/ext/success`
  // page (served by the user's configured backend) runs
  // `chrome.runtime.sendMessage(extId, { kind: "auth/token", token })`
  // from page context. Anything outside the configured backend origin is
  // ignored. Firefox doesn't expose `externally_connectable.matches` to
  // pages (Bugzilla 1319168), so this listener never fires there — the
  // `tabs.onUpdated` listener below handles Firefox via URL fragment.
  browser.runtime.onMessageExternal.addListener(
    (msg, sender, sendResponse: (r: { ok: boolean; error?: string }) => void) => {
      void handleExternal(msg, sender)
        .then(sendResponse)
        .catch((err) => {
          console.error("[margin] external message handler:", err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    },
  );

  // Tab-based OAuth bridge — fragment fallback. The bridge page sets
  // `location.hash = 'token=…'` when `chrome.runtime.sendMessage` isn't
  // available (Firefox today, or any other browser where the
  // externally_connectable bridge can't reach the SW). Match on URL
  // origin + pathname so a token in a random tab's fragment never lands
  // in `settings.sessionToken`.
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url ?? tab.url;
    if (!url) return;
    void handleAuthFragment(tabId, url);
  });
});

interface ExternalAuthMessage {
  kind: "auth/token";
  token: string;
}

function isExternalAuthMessage(msg: unknown): msg is ExternalAuthMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { kind?: unknown; token?: unknown };
  return m.kind === "auth/token" && typeof m.token === "string" && m.token.length > 0;
}

/**
 * Normalise a URL down to its origin for the bridge-page allow-list. Both
 * the stored backend URL (`http://localhost:8787` or similar) and Chrome's
 * `sender.origin` (e.g. `http://localhost:8787`) should compare equal after
 * stripping path / trailing slashes. Returns null when the input isn't a
 * parseable absolute URL — the caller treats that as a no-match.
 */
function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function handleExternal(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; error?: string }> {
  if (!isExternalAuthMessage(msg)) {
    return { ok: false, error: "unsupported message" };
  }
  const expected = originOf(await getBackendUrl());
  const actual = originOf(sender.origin ?? sender.url);
  if (!expected || !actual || expected !== actual) {
    // Don't echo the expected origin back — keep the rejection opaque.
    console.warn(
      "[margin] rejected external auth/token from",
      actual ?? "unknown sender",
    );
    return { ok: false, error: "origin not allowed" };
  }
  await patchSettings({ sessionToken: msg.token });
  return { ok: true };
}

/**
 * Firefox-path companion to `handleExternal`: the bridge page parks the
 * session token in `location.hash` because `externally_connectable.matches`
 * isn't honored. We gate on origin + pathname (so a token in some unrelated
 * tab's fragment never makes it into settings) and then close the bridge
 * tab once the token's been persisted.
 *
 * Reading `tab.url` requires either the `tabs` permission or matching host
 * permissions; the user grants the backend origin via the Options page's
 * `permissions.request({ origins: [...] })` flow, so by the time this
 * listener has anything to do, the URL is visible.
 */
async function handleAuthFragment(tabId: number, url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!parsed.hash || parsed.hash.length < 2) return;
  if (parsed.pathname !== "/api/auth/ext/success") return;

  const backendOrigin = originOf(await getBackendUrl());
  if (!backendOrigin || backendOrigin !== parsed.origin) return;

  const params = new URLSearchParams(parsed.hash.slice(1));
  const token = params.get("token");
  if (!token) return;

  await patchSettings({ sessionToken: token });
  try {
    await browser.tabs.remove(tabId);
  } catch (err) {
    console.warn("[margin] could not close auth bridge tab:", err);
  }
}

function errorResponseFor(message: Message | unknown, error: string): MessageResponse {
  const kind =
    typeof message === "object" && message !== null && "kind" in message
      ? (message as { kind: unknown }).kind
      : null;
  switch (kind) {
    case "settings/get":
      return { kind: "settings/get", settings: null, backendUrl: null, error };
    case "settings/set":
      return { kind: "settings/set", ok: true, error };
    case "auth/sign-out":
      return { kind: "auth/sign-out", ok: true, error };
    case "doc/state":
      return { kind: "doc/state", state: null, error };
    case "doc/sync":
      return { kind: "doc/sync", state: null, error };
    case "doc/register":
      return { kind: "doc/register", result: { kind: "error", message: error }, error };
    case "project/detail":
      return { kind: "project/detail", detail: null, error };
    case "version/diff":
      return { kind: "version/diff", payload: null, error };
    case "version/comments":
      return { kind: "version/comments", payload: null, error };
    case "comment/action":
      return { kind: "comment/action", result: null, error };
    case "settings/load":
      return { kind: "settings/load", settings: null, error };
    case "settings/update":
      return { kind: "settings/update", settings: null, error };
    default:
      // Unknown/malformed inbound kind — caller will see `error` set and
      // bail; the chosen discriminant doesn't matter for routing.
      return { kind: "settings/get", settings: null, backendUrl: null, error };
  }
}

async function handleMessage(message: Message): Promise<MessageResponse> {
  switch (message.kind) {
    case "settings/get": {
      const [settings, backendUrl] = await Promise.all([
        getSettings(),
        getBackendUrl(),
      ]);
      return { kind: "settings/get", settings, backendUrl };
    }
    case "settings/set": {
      await setSettings(message.settings);
      return { kind: "settings/set", ok: true };
    }
    case "auth/sign-out": {
      await signOutFromBackend();
      return { kind: "auth/sign-out", ok: true };
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
    case "version/comments": {
      const payload = await fetchVersionComments(message.versionId);
      return { kind: "version/comments", payload };
    }
    case "comment/action": {
      const result = await runCommentAction({
        canonicalCommentId: message.canonicalCommentId,
        action: message.action,
        targetVersionId: message.targetVersionId,
      });
      return { kind: "comment/action", result };
    }
    case "settings/load": {
      const settings = await loadProjectSettings(message.projectId);
      return { kind: "settings/load", settings };
    }
    case "settings/update": {
      const settings = await updateProjectSettings(message.projectId, message.patch);
      return { kind: "settings/update", settings };
    }
  }
}
