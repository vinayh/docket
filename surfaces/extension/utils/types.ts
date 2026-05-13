export interface Settings {
  backendUrl: string;
  // Better Auth session token. Sent as `Authorization: Bearer <token>` on every backend call.
  sessionToken: string;
}

export const DEFAULT_BACKEND_URL = "http://localhost:8787";

// Mirror of backend's DocStateResponse. Discriminated on `tracked`.
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

// `kind: "registered"` covers both fresh registration (200) and already-tracked (409).
export type RegisterDocResult =
  | { kind: "registered"; projectId: string; parentDocId: string; alreadyExisted: boolean }
  | { kind: "error"; message: string };

export interface ProjectListEntry {
  id: string;
  parentDocId: string;
  createdAt: number;
}

// Mirror of backend's ProjectDetail. Keep field names/types in sync.
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
  assignees: ReviewAssigneeView[];
}

export type ReviewAssignmentStatus =
  | "pending"
  | "reviewed"
  | "changes_requested"
  | "declined";

export interface ReviewAssigneeView {
  email: string;
  userId: string;
  status: ReviewAssignmentStatus;
  respondedAt: number | null;
}

export type ReviewActionKind =
  | "mark_reviewed"
  | "request_changes"
  | "decline"
  | "accept_reconciliation";

export interface ReviewRequestResult {
  reviewRequestId: string;
  versionId: string;
  assignees: {
    email: string;
    userId: string;
    links: { action: ReviewActionKind; url: string; expiresAt: number }[];
  }[];
}

export interface VersionCreateResult {
  versionId: string;
  label: string;
  googleDocId: string;
}

// Mirror of backend's VersionDiffPayload. Keep field names/types in sync.
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

// Mirror of backend's VersionCommentsPayload. Keep field names/types in sync.
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

// Mirror of backend's CommentActionKind.
export type CommentActionKind =
  | "accept_projection"
  | "reanchor"
  | "mark_resolved"
  | "mark_wontfix"
  | "reopen";

export interface CommentActionResult {
  canonicalCommentId: string;
  status: CanonicalCommentStatus;
  projection: {
    versionId: string;
    status: ProjectionStatus;
    anchorMatchConfidence: number | null;
  } | null;
}

// Mirror of backend's ProjectSettingsView.
export interface ProjectSettingsView {
  notifyOnComment: boolean;
  notifyOnReviewComplete: boolean;
  defaultReviewerEmails: string[];
  defaultOverlayId: string | null;
  slackWorkspaceRef: string | null;
}
