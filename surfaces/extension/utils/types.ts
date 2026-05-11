/**
 * Wire format shared between the content script, service worker, and the
 * Margin backend's `/api/extension/captures` endpoint. Mirror of the
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

/**
 * Mirror of the backend's `ProjectDetail` (src/domain/project-detail.ts) —
 * dashboard payload for one project. Keep field names/types in sync.
 */
export interface ProjectDetail {
  project: {
    id: string;
    parentDocId: string;
    ownerEmail: string | null;
    createdAt: number;
  };
  versions: ProjectVersionDetail[];
  derivatives: ProjectDerivativeDetail[];
  reviewRequests: ProjectReviewRequestDetail[];
}

export interface ProjectVersionDetail {
  id: string;
  label: string;
  googleDocId: string;
  status: "active" | "archived";
  parentVersionId: string | null;
  createdAt: number;
  commentCount: number;
  lastSyncedAt: number | null;
}

export interface ProjectDerivativeDetail {
  id: string;
  versionId: string;
  overlayId: string;
  googleDocId: string;
  audienceLabel: string | null;
  createdAt: number;
}

export interface ProjectReviewRequestDetail {
  id: string;
  versionId: string;
  status: "open" | "closed" | "cancelled";
  deadline: number | null;
  createdAt: number;
}

/**
 * Mirror of `VersionDiffPayload` from src/domain/version-diff.ts —
 * structured side-by-side diff payload (paragraph summaries) for two
 * versions of the same project. Keep field names/types in sync.
 */
export interface VersionDiffPayload {
  from: VersionDiffSide;
  to: VersionDiffSide;
}

export interface VersionDiffSide {
  versionId: string;
  label: string;
  googleDocId: string;
  paragraphs: ParagraphSummary[];
}

export interface ParagraphSummary {
  plaintext: string;
  namedStyleType: string | null;
  runs: RunSummary[];
}

export interface RunSummary {
  content: string;
  style: TextStyleSummary | null;
}

export interface TextStyleSummary {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  foregroundColorHex?: string;
}

/**
 * Mirror of `VersionCommentsPayload` from src/domain/version-comments.ts —
 * canonical comments projected onto a single version, with projection
 * status + origin-version attribution. Powers the side-panel comment
 * reconciliation view. Keep field names/types in sync.
 */
export interface VersionCommentsPayload {
  versionId: string;
  versionLabel: string;
  projectId: string;
  comments: VersionCommentEntry[];
}

export type CanonicalCommentKind =
  | "comment"
  | "suggestion_insert"
  | "suggestion_delete";

export type CanonicalCommentStatus =
  | "open"
  | "addressed"
  | "wontfix"
  | "superseded";

export type ProjectionStatus =
  | "clean"
  | "fuzzy"
  | "orphaned"
  | "manually_resolved";

export interface VersionCommentAnchor {
  quotedText: string;
  contextBefore?: string;
  contextAfter?: string;
  paragraphHash?: string;
  structuralPosition?: {
    region?: "body" | "header" | "footer" | "footnote";
    regionId?: string;
    paragraphIndex: number;
    offset: number;
  };
}

export interface VersionCommentEntry {
  canonicalCommentId: string;
  parentCanonicalCommentId: string | null;
  kind: CanonicalCommentKind;
  body: string;
  anchor: VersionCommentAnchor;
  status: CanonicalCommentStatus;
  originVersionId: string;
  originVersionLabel: string;
  originUserDisplayName: string | null;
  originUserEmail: string | null;
  originTimestamp: number;
  projection: VersionProjectionEntry;
}

export interface VersionProjectionEntry {
  status: ProjectionStatus;
  anchorMatchConfidence: number | null;
  googleCommentId: string | null;
  lastSyncedAt: number;
}
