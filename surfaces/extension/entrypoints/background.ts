import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import type { Message, MessageResponse } from "../utils/messages.ts";
import { getBackendUrl, getSettings, patchSettings, setSettings } from "../utils/storage.ts";
import type {
  CommentActionKind,
  CommentActionResult,
  DocState,
  ProjectDetail,
  ProjectSettingsView,
  RegisterDocResult,
  Settings,
  VersionCommentsPayload,
  VersionDiffPayload,
} from "../utils/types.ts";

/**
 * MV3 service worker. Sole job is routing popup / side-panel messages to
 * authenticated backend endpoints. Pre-docx-ingest the SW also owned a
 * capture queue + flush loop fed by the docs.google.com content script;
 * that pipeline is gone (SPEC §9.8 — backend exports the doc as `.docx`
 * and parses it server-side).
 *
 * State this SW touches: settings only (in chrome.storage.local). No queue,
 * no seen-set, no per-doc cache. The SW can spin up cold on every message
 * without losing anything.
 */

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
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
 * isn't honored. We gate on origin + pathname (so a token in some
 * unrelated tab's fragment never makes it into settings) and then close
 * the bridge tab once the token's been persisted.
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

function errorResponseFor(message: Message, error: string): MessageResponse {
  switch (message.kind) {
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
  const res = await postJsonRaw(path, body, settings);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Variant of postJson where the route signals "not found / not visible
 * to this caller" with a 404. Returns null on 404; throws on everything
 * else non-ok. Used by side-panel routes that map missing/not-owner
 * cases into a "no such project" UI state.
 */
async function postJsonOrNull<T>(
  path: string,
  body: unknown,
  settings: Settings,
): Promise<T | null> {
  const res = await postJsonRaw(path, body, settings);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function postJsonRaw(
  path: string,
  body: unknown,
  settings: Settings,
): Promise<Response> {
  const url = new URL(path, settings.backendUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.sessionToken}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("session rejected — sign in again from Options");
  }
  return res;
}

/**
 * Drop the local session token. We also POST to Better Auth's `/sign-out`
 * endpoint so the corresponding `session` row in the DB is invalidated —
 * a stolen token left active in the DB after a "sign out" would defeat the
 * purpose. Failures here don't block local clear: the backend session will
 * expire on its own.
 */
async function signOutFromBackend(): Promise<void> {
  const settings = await getSettings();
  if (settings) {
    try {
      const url = new URL("/api/auth/sign-out", settings.backendUrl).toString();
      await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${settings.sessionToken}` },
      });
    } catch (err) {
      console.warn("[margin] sign-out backend call failed:", err);
    }
  }
  await patchSettings({ sessionToken: "" });
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
  let res: Response;
  try {
    // postJsonRaw is the shared auth + URL-build helper; it throws on 401/403
    // with the same "API token rejected" message we want surfaced here.
    res = await postJsonRaw("/api/picker/register-doc", { docUrlOrId }, settings);
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
  return postJsonOrNull<ProjectDetail>(
    "/api/extension/project",
    { projectId },
    settings,
  );
}

async function fetchVersionDiff(
  fromVersionId: string,
  toVersionId: string,
): Promise<VersionDiffPayload | null> {
  const settings = await getSettings();
  if (!settings) return null;
  return postJsonOrNull<VersionDiffPayload>(
    "/api/extension/version-diff",
    { fromVersionId, toVersionId },
    settings,
  );
}

async function fetchVersionComments(
  versionId: string,
): Promise<VersionCommentsPayload | null> {
  const settings = await getSettings();
  if (!settings) return null;
  return postJsonOrNull<VersionCommentsPayload>(
    "/api/extension/version-comments",
    { versionId },
    settings,
  );
}

async function runCommentAction(opts: {
  canonicalCommentId: string;
  action: CommentActionKind;
  targetVersionId?: string;
}): Promise<CommentActionResult | null> {
  const settings = await getSettings();
  if (!settings) return null;
  return postJsonOrNull<CommentActionResult>(
    "/api/extension/comment-action",
    opts,
    settings,
  );
}

async function loadProjectSettings(
  projectId: string,
): Promise<ProjectSettingsView | null> {
  const settings = await getSettings();
  if (!settings) return null;
  const r = await postJsonOrNull<{ settings: ProjectSettingsView }>(
    "/api/extension/settings",
    { projectId },
    settings,
  );
  return r?.settings ?? null;
}

async function updateProjectSettings(
  projectId: string,
  patch: Partial<ProjectSettingsView>,
): Promise<ProjectSettingsView | null> {
  const settings = await getSettings();
  if (!settings) return null;
  const r = await postJsonOrNull<{ settings: ProjectSettingsView }>(
    "/api/extension/settings",
    { projectId, patch },
    settings,
  );
  return r?.settings ?? null;
}

