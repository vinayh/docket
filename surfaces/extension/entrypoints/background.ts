import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import type { Message, MessageResponse } from "../utils/messages.ts";
import { getSettings, patchSettings, setSettings } from "../utils/storage.ts";
import type {
  CommentActionKind,
  CommentActionResult,
  DocState,
  PickerConfig,
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
});

function errorResponseFor(message: Message, error: string): MessageResponse {
  switch (message.kind) {
    case "settings/get":
      return { kind: "settings/get", settings: null, error };
    case "settings/set":
      return { kind: "settings/set", ok: true, error };
    case "auth/sign-in":
      return { kind: "auth/sign-in", ok: false, error };
    case "auth/sign-out":
      return { kind: "auth/sign-out", ok: true, error };
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
      const settings = await getSettings();
      return { kind: "settings/get", settings };
    }
    case "settings/set": {
      await setSettings(message.settings);
      return { kind: "settings/set", ok: true };
    }
    case "auth/sign-in": {
      await signInWithGoogle(message.backendUrl);
      return { kind: "auth/sign-in", ok: true };
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
 * Drive `chrome.identity.launchWebAuthFlow` through Better Auth's social
 * sign-in flow. The backend's `/api/auth/ext/launch` endpoint kicks off
 * Google OAuth and ultimately 302s to the extension's `chromiumapp.org`
 * callback URL with `#token=<sessionToken>` as a URL fragment; we extract
 * that and persist it as the Authorization header source for every
 * subsequent backend call. The fragment (vs. query param) keeps the token
 * out of any server log that might otherwise record the redirect target.
 */
async function signInWithGoogle(backendUrl: string): Promise<void> {
  const trimmed = backendUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("backend URL required to sign in");
  const cb = browser.identity.getRedirectURL();
  const launchUrl =
    `${trimmed}/api/auth/ext/launch?cb=${encodeURIComponent(cb)}`;

  const completed = await browser.identity.launchWebAuthFlow({
    url: launchUrl,
    interactive: true,
  });
  if (!completed) throw new Error("sign-in was cancelled");

  const url = new URL(completed);
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hash);
  const token = params.get("token");
  if (!token) throw new Error("sign-in did not return a session token");

  await patchSettings({ backendUrl: trimmed, sessionToken: token });
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
