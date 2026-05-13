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

// Authenticated client used only from the SW. Popup / sidepanel never see the session token —
// they sendMessage to the SW and the SW attaches the Bearer header here.

async function postJson<T>(path: string, body: unknown, settings: Settings): Promise<T> {
  const res = await postJsonRaw(path, body, settings);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// Returns null on 404 (e.g. "no such project / not yours"); throws otherwise.
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

// Calls Better Auth's /sign-out so the DB session row is invalidated. Backend failures
// still clear the local token (the row will expire on its own).
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

// null = settings missing (popup renders that as "configure backend"). Network errors throw.
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

// Maps both 200 (created) and 409 already_exists into the same `registered` shape.
export async function registerDoc(docUrlOrId: string): Promise<RegisterDocResult> {
  const settings = await getSettings();
  if (!settings) return { kind: "error", message: "no settings configured" };
  let res: Response;
  try {
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
