import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/sqlite-core";

const newId = () => crypto.randomUUID();
const now = () => new Date();

// user/session/account/verification are Better Auth tables. Column names follow its expectations.
export const user = sqliteTable("user", {
  id: text("id").primaryKey().$defaultFn(newId),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    // Envelope-encrypted on write; decrypted by tokenProviderForUser.
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("account_user_idx").on(t.userId),
    uniqueIndex("account_provider_account_unique").on(t.providerId, t.accountId),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// JSON blob on project.settings. Read via loadProjectSettings; unset fields fall back to defaults.
export type ProjectSettings = {
  defaultReviewerEmails?: string[];
  defaultOverlayId?: string;
  notifyOnComment?: boolean;
  notifyOnReviewComplete?: boolean;
  // Free-form for now; Phase 5 will write a structured { teamId, channelId } here.
  slackWorkspaceRef?: string;
};

export const project = sqliteTable(
  "project",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    parentDocId: text("parent_doc_id").notNull(),
    // Drive `files.get` name at registration time. Nullable for pre-migration
    // rows; refreshed on next doc-sync. Authoritative source for the doc
    // title shown in the popup / side panel — the extension's tab-title
    // fallback is locale-fragile.
    name: text("name"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    settings: text("settings", { mode: "json" })
      .$type<ProjectSettings>()
      .notNull()
      .$defaultFn(() => ({})),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  // Note: project identity is intentionally NOT bound to parent_doc_id — the
  // parent doc URL can be swapped over a project's lifetime. createProject's
  // "this doc is already tracked" pre-check is enforced at the application
  // layer (DuplicateProjectError) so the picker UX can still surface it.
  (_t) => [],
);

export type VersionStatus = "active" | "archived";

export const version = sqliteTable(
  "version",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    googleDocId: text("google_doc_id").notNull(),
    // Drive `files.get` name for the version copy. Same nullable + fallback
    // semantics as `project.name`. Typically `[Margin <label>] <parent name>`.
    name: text("name"),
    parentVersionId: text("parent_version_id"),
    label: text("label").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    snapshotContentHash: text("snapshot_content_hash"),
    status: text("status").$type<VersionStatus>().notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("version_project_idx").on(t.projectId),
    // Pairs with nextAutoLabel's MAX+1 so a race surfaces as a conflict instead of dup labels.
    uniqueIndex("version_project_label_unique").on(t.projectId, t.label),
    foreignKey({ columns: [t.parentVersionId], foreignColumns: [t.id] }),
  ],
);

export const overlay = sqliteTable(
  "overlay",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("overlay_project_idx").on(t.projectId)],
);

export type OverlayOpType = "redact" | "replace" | "insert" | "append";

export type OverlayAnchor = {
  quotedText: string;
  contextBefore?: string;
  contextAfter?: string;
  paragraphHash?: string;
};

export const overlayOperation = sqliteTable(
  "overlay_operation",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    overlayId: text("overlay_id")
      .notNull()
      .references(() => overlay.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    type: text("type").$type<OverlayOpType>().notNull(),
    anchor: text("anchor", { mode: "json" }).$type<OverlayAnchor>().notNull(),
    payload: text("payload"),
    confidenceThreshold: integer("confidence_threshold"),
  },
  (t) => [index("overlay_op_overlay_idx").on(t.overlayId, t.orderIndex)],
);

export const derivative = sqliteTable("derivative", {
  id: text("id").primaryKey().$defaultFn(newId),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  versionId: text("version_id")
    .notNull()
    .references(() => version.id),
  overlayId: text("overlay_id")
    .notNull()
    .references(() => overlay.id),
  googleDocId: text("google_doc_id").notNull(),
  audienceLabel: text("audience_label"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export type DocRegion = "body" | "header" | "footer" | "footnote";

// One additional range of a multi-range comment. The primary lives on structuralPosition.
export type AnchorRange = {
  region: DocRegion;
  regionId?: string;
  startParagraphIndex: number;
  startOffset: number;
  endParagraphIndex: number;
  endOffset: number;
};

export type CommentAnchor = {
  quotedText: string;
  contextBefore?: string;
  contextAfter?: string;
  paragraphHash?: string;
  structuralPosition?: {
    // Omitted region defaults to "body" (back-compat).
    region?: DocRegion;
    // Required when region != "body".
    regionId?: string;
    paragraphIndex: number;
    offset: number;
  };
  // Sorted in document order (region, regionId, paragraphIndex, startOffset).
  additionalRanges?: AnchorRange[];
};

export type CanonicalCommentStatus = "open" | "addressed" | "wontfix" | "superseded";

/**
 * What kind of doc annotation produced this canonical_comment.
 * - `comment`: Drive comment thread or reply. Author/timestamp from the API.
 * - `suggestion_insert` / `suggestion_delete`: a tracked-change suggestion. Author/timestamp
 *   aren't surfaced by `documents.get`; resolving via the Drive revisions API is deferred
 *   (SPEC Phase 6). Reply threads on a suggestion are stored internally by Google and not
 *   exposed by any public API (verified empirically). Use `bun margin inspect <url>` to confirm.
 */
export type CanonicalCommentKind = "comment" | "suggestion_insert" | "suggestion_delete";

export const canonicalComment = sqliteTable(
  "canonical_comment",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    originVersionId: text("origin_version_id")
      .notNull()
      .references(() => version.id),
    originUserId: text("origin_user_id").references(() => user.id),
    originUserEmail: text("origin_user_email"),
    originUserDisplayName: text("origin_user_display_name"),
    // Short SHA-256 of Drive photoLink; disambiguates reviewers sharing a display name.
    originPhotoHash: text("origin_photo_hash"),
    originTimestamp: integer("origin_timestamp", { mode: "timestamp_ms" }).notNull(),
    kind: text("kind").$type<CanonicalCommentKind>().notNull().default("comment"),
    anchor: text("anchor", { mode: "json" }).$type<CommentAnchor>().notNull(),
    body: text("body").notNull(),
    status: text("status").$type<CanonicalCommentStatus>().notNull().default("open"),
    parentCommentId: text("parent_comment_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("canonical_comment_project_idx").on(t.projectId),
    foreignKey({ columns: [t.parentCommentId], foreignColumns: [t.id] }),
  ],
);

export type ProjectionStatus = "clean" | "fuzzy" | "orphaned" | "manually_resolved";

export const commentProjection = sqliteTable(
  "comment_projection",
  {
    canonicalCommentId: text("canonical_comment_id")
      .notNull()
      .references(() => canonicalComment.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => version.id, { onDelete: "cascade" }),
    googleCommentId: text("google_comment_id"),
    anchorMatchConfidence: integer("anchor_match_confidence"),
    projectionStatus: text("projection_status").$type<ProjectionStatus>().notNull(),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [
    primaryKey({ columns: [t.canonicalCommentId, t.versionId] }),
    // Lets upsertCanonical detect a concurrent-ingest race and fall back to the existing row.
    uniqueIndex("comment_projection_version_google_unique").on(
      t.versionId,
      t.googleCommentId,
    ),
  ],
);

export type ReviewRequestStatus = "open" | "closed" | "cancelled";

export const reviewRequest = sqliteTable("review_request", {
  id: text("id").primaryKey().$defaultFn(newId),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  versionId: text("version_id")
    .notNull()
    .references(() => version.id),
  status: text("status").$type<ReviewRequestStatus>().notNull().default("open"),
  deadline: integer("deadline", { mode: "timestamp_ms" }),
  slackThreadRef: text("slack_thread_ref"),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export type ReviewAssignmentStatus = "pending" | "reviewed" | "changes_requested" | "declined";

export const reviewAssignment = sqliteTable(
  "review_assignment",
  {
    reviewRequestId: text("review_request_id")
      .notNull()
      .references(() => reviewRequest.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    status: text("status")
      .$type<ReviewAssignmentStatus>()
      .notNull()
      .default("pending"),
    respondedAt: integer("responded_at", { mode: "timestamp_ms" }),
  },
  (t) => [primaryKey({ columns: [t.reviewRequestId, t.userId] })],
);

// Tracks active Drive files.watch channels so the watcher can renew and map push → version.
export const driveWatchChannel = sqliteTable(
  "drive_watch_channel",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    versionId: text("version_id")
      .notNull()
      .references(() => version.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull().unique(),
    resourceId: text("resource_id").notNull(),
    // Echoed back as X-Goog-Channel-Token.
    token: text("token"),
    address: text("address").notNull(),
    expiration: integer("expiration", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    lastEventAt: integer("last_event_at", { mode: "timestamp_ms" }),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("drive_watch_version_idx").on(t.versionId)],
);

/**
 * Magic-link review actions. The first three are review_assignment state transitions;
 * `accept_reconciliation` covers the cross-version "yes, this v1 comment is still open
 * on v2" confirmation (SPEC §7.4 step 5).
 */
export type ReviewActionKind =
  | "mark_reviewed"
  | "decline"
  | "request_changes"
  | "accept_reconciliation";

// Magic-link token. Stored as sha256. One row per (reviewRequestId, assigneeUserId);
// reusable until expiry — the action is passed as a query param at redeem time, so
// reviewers can change their response (e.g. mark_reviewed → request_changes) without
// the requester re-issuing a link.
export const reviewActionToken = sqliteTable(
  "review_action_token",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tokenHash: text("token_hash").notNull().unique(),
    // Denormalized (review_request_id, user_id) because assignment has no single-column id.
    reviewRequestId: text("review_request_id")
      .notNull()
      .references(() => reviewRequest.id, { onDelete: "cascade" }),
    assigneeUserId: text("assignee_user_id")
      .notNull()
      .references(() => user.id),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    // Set on every successful redeem; null until first use.
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("review_action_token_assignment_idx").on(
      t.reviewRequestId,
      t.assigneeUserId,
    ),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    before: text("before", { mode: "json" }).$type<Record<string, unknown>>(),
    after: text("after", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("audit_target_idx").on(t.targetType, t.targetId),
    index("audit_actor_idx").on(t.actorUserId),
  ],
);
