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

/**
 * Multipart upload of bytes as a new Drive file with format conversion. Used by
 * the V2 empirical check (SPEC §12 Phase 6) to verify that uploading a known
 * `.docx` and converting to a Google Doc preserves anchored comments. The
 * RFC 2387 boundary is fixed because this is a one-shot upload — we don't
 * need stream-friendly framing.
 */
export async function uploadFileMultipart(
  tp: TokenProvider,
  opts: {
    name: string;
    bytes: Uint8Array;
    sourceMimeType: string;
    targetMimeType?: string;
  },
): Promise<DriveFile> {
  const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", DEFAULT_FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");

  const boundary = `margin-${crypto.randomUUID()}`;
  const metadata = {
    name: opts.name,
    ...(opts.targetMimeType ? { mimeType: opts.targetMimeType } : {}),
  };
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\n` +
      `Content-Type: ${opts.sourceMimeType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + opts.bytes.length + tail.length);
  body.set(head, 0);
  body.set(opts.bytes, head.length);
  body.set(tail, head.length + opts.bytes.length);

  return authedJson(tp, url, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
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

export interface CreatedPermission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
}

/**
 * Share a Drive file with a single user by email. The doc owner's token is the
 * caller (cross-org reviewers grant no Drive scope themselves — SPEC §7.2);
 * `sendNotificationEmail=false` because Margin sends its own review-request
 * email with magic-link buttons.
 */
export async function createPermission(
  tp: TokenProvider,
  fileId: string,
  opts: {
    emailAddress: string;
    role?: "reader" | "commenter" | "writer";
    sendNotificationEmail?: boolean;
  },
): Promise<CreatedPermission> {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`);
  url.searchParams.set("fields", "id,type,role,emailAddress");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "sendNotificationEmail",
    opts.sendNotificationEmail === true ? "true" : "false",
  );
  return authedJson(tp, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "user",
      role: opts.role ?? "commenter",
      emailAddress: opts.emailAddress,
    }),
  });
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

