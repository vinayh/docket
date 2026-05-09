/**
 * Wire format shared between the content script, service worker, and the
 * Docket backend's `/api/extension/captures` endpoint. Mirror of the
 * `CaptureInput` type in `src/domain/capture.ts` — keep in sync.
 */
export interface CaptureInput {
  externalId: string;
  docId: string;
  kixDiscussionId?: string;
  parentQuotedText?: string;
  authorDisplayName?: string;
  authorEmail?: string;
  createdAt?: string;
  body: string;
}

export type CaptureStatus =
  | "inserted"
  | "duplicate"
  | "orphaned"
  | "version_unknown"
  | "error";

export interface CaptureResult {
  externalId: string;
  status: CaptureStatus;
  canonicalCommentId?: string;
  message?: string;
}

export interface IngestCapturesResult {
  results: CaptureResult[];
  inserted: number;
  duplicate: number;
  orphaned: number;
  versionUnknown: number;
  errored: number;
}

export interface Settings {
  backendUrl: string;
  apiToken: string;
}

export const DEFAULT_BACKEND_URL = "http://localhost:8787";
