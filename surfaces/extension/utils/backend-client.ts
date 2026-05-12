import { getSettings, patchSettings } from "./storage.ts";
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
} from "./types.ts";

/**
 * Thin authenticated client the SW uses for every backend round-trip. Lives
 * here (not inline in `background.ts`) so the SW entry point stays focused
 * on message routing + the external-auth bridge.
 *
 * One token rule: the popup / sidepanel never see the session token — they
 * `sendMessage` to the SW and the SW reads `chrome.storage.local` and sets
 * the `Authorization: Bearer …` header here. A missing or rejected token
 * surfaces the same prompt everywhere so the user gets one consistent
 * "sign in again from Options" message.
 */

/**
 * Authenticated POST helper. One place for: URL build, auth header, friendly
 * 401/403 message, body-prefix-on-error, JSON parse. Every SW fetch wrapper
 * that authenticates with the user's session token routes through here so a
 * single missing/expired token yields the same prompt everywhere.
 */
async function postJson<T>(path: string, body: unknown, settings: Settings): Promise<T> {
  const res = await postJsonRaw(path, body, settings);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Variant of postJson where the route signals "not found / not visible to
 * this caller" with a 404. Returns null on 404; throws on everything else
 * non-ok. Used by side-panel routes that map missing/not-owner cases into
 * a "no such project" UI state.
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
 * endpoint so the corresponding `session` row in the DB is invalidated — a
 * stolen token left active in the DB after a "sign out" would defeat the
 * purpose. Failures here don't block local clear: the backend session will
 * expire on its own.
 */
export async function signOutFromBackend(): Promise<void> {
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
 * Routes the popup's "is this doc tracked?" query to the backend's doc-state
 * endpoint. Returns null when settings are missing — the popup renders that
 * as a configuration error rather than an unknown-doc state. Network / auth
 * failures bubble up via the message-handler error path.
 */
export async function fetchDocState(docId: string): Promise<DocState | null> {
  const settings = await getSettings();
  if (!settings) return null;
  return postJson<DocState>("/api/extension/doc-state", { docId }, settings);
}

export async function runDocSync(docId: string): Promise<DocState | null> {
  const settings = await getSettings();
  if (!settings) return null;
  return postJson<DocState>("/api/extension/doc-sync", { docId }, settings);
}

/**
 * Calls /api/picker/register-doc on the popup's behalf — the sandboxed picker
 * iframe can't reach the backend (null origin), so it postMessages the picked
 * id up to the popup, the popup dispatches here. Maps both 200 (created) and
 * 409 already_exists into the same `registered` shape because the popup
 * treats them identically: show "tracked, project <id>".
 */
export async function registerDoc(docUrlOrId: string): Promise<RegisterDocResult> {
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
  if (
    res.status === 409 &&
    body.error === "already_exists" &&
    body.projectId &&
    body.parentDocId
  ) {
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
 * Routes the side-panel's project-dashboard query through the SW so the
 * session token never reaches the side-panel origin. Returns null on 404
 * (missing / not-owner) so the panel can render a "no such project" state
 * without conflating it with network errors.
 */
export async function fetchProjectDetail(projectId: string): Promise<ProjectDetail | null> {
  const settings = await getSettings();
  if (!settings) return null;
  return postJsonOrNull<ProjectDetail>(
    "/api/extension/project",
    { projectId },
    settings,
  );
}

export async function fetchVersionDiff(
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

export async function fetchVersionComments(
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

export async function runCommentAction(opts: {
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

export async function loadProjectSettings(
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

export async function updateProjectSettings(
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
