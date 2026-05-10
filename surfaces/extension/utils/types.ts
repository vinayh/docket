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

/**
 * Mirror of the backend's `DocStateResponse` (src/domain/doc-state.ts).
 * Discriminated on `tracked`. The popup branches between the onboarding
 * affordance (`tracked: false`) and the project surface (`tracked: true`).
 */
export type DocState =
  | { tracked: false; docId: string }
  | {
      tracked: true;
      docId: string;
      role: "parent" | "version";
      project: {
        id: string;
        parentDocId: string;
        ownerEmail: string | null;
        createdAt: number;
      };
      version: {
        id: string;
        label: string;
        googleDocId: string;
        status: "active" | "archived";
        createdAt: number;
      } | null;
      lastSyncedAt: number | null;
      commentCount: number;
      openReviewCount: number;
    };

/**
 * Picker runtime config the popup pulls from the backend (via /picker-config)
 * and forwards to the sandboxed picker iframe. Same fields the backend's
 * inline /picker page consumes — keeps both in sync.
 */
export interface PickerConfig {
  clientId: string;
  apiKey: string;
  projectNumber: string;
}

/**
 * Result of POST /api/picker/register-doc as the SW returns it to the popup.
 * `kind: "registered"` covers both first-time registration (200) and the
 * already-tracked case (409): the popup just renders the project id either
 * way. `kind: "error"` carries a user-readable message.
 */
export type RegisterDocResult =
  | { kind: "registered"; projectId: string; parentDocId: string; alreadyExisted: boolean }
  | { kind: "error"; message: string };
