import { authedFetch, authedJson, type TokenProvider } from "./api.ts";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
  webViewLink?: string;
  trashed?: boolean;
}

const DEFAULT_FILE_FIELDS = "id,name,mimeType,modifiedTime,createdTime,parents,webViewLink,trashed";

export async function getFile(
  tp: TokenProvider,
  fileId: string,
  opts: { fields?: string } = {},
): Promise<DriveFile> {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", opts.fields ?? DEFAULT_FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  return authedJson(tp, url);
}

/**
 * Stream a Google Doc out as an OOXML (`.docx`) zip. This is the canonical
 * ingest source — see SPEC §9.8 for the rationale and the matrix of which
 * signals show up here that `comments.list` / `documents.get` drop.
 *
 * Returns the raw bytes; parsing lives in `src/google/docx.ts`. We don't
 * stream-decompress here because the parser needs the whole zip in memory
 * to read `word/comments.xml` alongside `word/document.xml` anyway.
 */
export async function exportDocx(
  tp: TokenProvider,
  fileId: string,
): Promise<Uint8Array> {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export`);
  url.searchParams.set(
    "mimeType",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const res = await authedFetch(tp, url);
  if (!res.ok) {
    throw new Error(`exportDocx failed: ${res.status} ${await res.text()}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function copyFile(
  tp: TokenProvider,
  fileId: string,
  opts: { name?: string; parents?: string[] } = {},
): Promise<DriveFile> {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/copy`);
  url.searchParams.set("fields", DEFAULT_FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  return authedJson(tp, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
}

export interface DriveCommentAuthor {
  displayName?: string;
  emailAddress?: string;
  me?: boolean;
  /**
   * Per-user URL. Used as a disambiguator for two reviewers sharing a display
   * name (OOXML doesn't surface this — SPEC §9.8). Hashed and stored as
   * `canonical_comment.origin_user_photo_hash`-equivalent on the anchor; we
   * never persist the raw URL.
   */
  photoLink?: string;
}

export interface DriveCommentReply {
  id: string;
  author?: DriveCommentAuthor;
  createdTime: string;
  modifiedTime?: string;
  content: string;
  htmlContent?: string;
  deleted?: boolean;
  action?: "resolve" | "reopen";
}

export interface DriveComment {
  id: string;
  author?: DriveCommentAuthor;
  createdTime: string;
  modifiedTime?: string;
  content: string;
  htmlContent?: string;
  quotedFileContent?: { mimeType: string; value: string };
  resolved?: boolean;
  deleted?: boolean;
  anchor?: string;
  replies?: DriveCommentReply[];
}

const COMMENT_FIELDS =
  "comments(id,author(displayName,emailAddress,me,photoLink),createdTime,modifiedTime,content,htmlContent,quotedFileContent,resolved,deleted,anchor,replies(id,author(displayName,emailAddress,me,photoLink),createdTime,modifiedTime,content,htmlContent,deleted,action)),nextPageToken";

interface CommentListResponse {
  comments?: DriveComment[];
  nextPageToken?: string;
}

export async function listComments(
  tp: TokenProvider,
  fileId: string,
  opts: { includeDeleted?: boolean; startModifiedTime?: string } = {},
): Promise<DriveComment[]> {
  const all: DriveComment[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/comments`);
    url.searchParams.set("fields", COMMENT_FIELDS);
    url.searchParams.set("pageSize", "100");
    if (opts.includeDeleted) url.searchParams.set("includeDeleted", "true");
    if (opts.startModifiedTime) url.searchParams.set("startModifiedTime", opts.startModifiedTime);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page: CommentListResponse = await authedJson(tp, url);
    if (page.comments) all.push(...page.comments);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return all;
}

export interface WatchChannel {
  kind: "api#channel";
  id: string;
  resourceId: string;
  resourceUri: string;
  expiration?: string;
  token?: string;
}

export interface WatchOptions {
  channelId: string;
  address: string;
  token?: string;
  expirationMs?: number;
}

export async function watchFile(
  tp: TokenProvider,
  fileId: string,
  opts: WatchOptions,
): Promise<WatchChannel> {
  return authedJson(tp, `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: opts.channelId,
      type: "web_hook",
      address: opts.address,
      token: opts.token,
      expiration: opts.expirationMs?.toString(),
    }),
  });
}

export async function stopChannel(
  tp: TokenProvider,
  channel: { id: string; resourceId: string },
): Promise<void> {
  const res = await authedFetch(tp, `${DRIVE_BASE}/channels/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(channel),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`stopChannel failed: ${res.status} ${await res.text()}`);
  }
}

