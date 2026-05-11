import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  foreignKey,
} from "drizzle-orm/sqlite-core";

const newId = () => crypto.randomUUID();
const now = () => new Date();

export type AuthMethod = "google" | "sso" | "magic_link";

export const user = sqliteTable("user", {
  id: text("id").primaryKey().$defaultFn(newId),
  email: text("email").notNull().unique(),
  googleSubjectId: text("google_subject_id").unique(),
  displayName: text("display_name"),
  homeOrg: text("home_org"),
  authMethod: text("auth_method").$type<AuthMethod>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export const driveCredential = sqliteTable(
  "drive_credential",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
    associatedProjectIds: text("associated_project_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("drive_credential_user_idx").on(t.userId)],
);

export type ProjectSettings = {
  defaultReviewerIds?: string[];
  defaultOverlayId?: string;
};

export const project = sqliteTable("project", {
  id: text("id").primaryKey().$defaultFn(newId),
  parentDocId: text("parent_doc_id").notNull(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  settings: text("settings", { mode: "json" })
    .$type<ProjectSettings>()
    .notNull()
    .$defaultFn(() => ({})),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export type VersionStatus = "active" | "archived";

export const version = sqliteTable(
  "version",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    googleDocId: text("google_doc_id").notNull(),
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

/**
 * Range coordinates for one disjoint span of a multi-range comment. Populated
 * when a `<w:comment>` exported as multiple OOXML rows sharing (author, date,
 * body) collapses into one `canonical_comment` (SPEC §9.8). The primary span
 * is the `structuralPosition` on the parent `CommentAnchor`; this type covers
 * the *additional* ranges only.
 */
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
    /** Region of the doc this anchor lives in. Omitted = "body" (back-compat). */
    region?: DocRegion;
    /** ID of the header/footer/footnote element. Required when region != "body". */
    regionId?: string;
    /** Zero-based paragraph index, local to the region. */
    paragraphIndex: number;
    offset: number;
  };
  /**
   * Extra disjoint ranges, populated when a comment was exported as multiple
   * OOXML rows sharing (author, date, body). The primary range lives on
   * `structuralPosition`; everything else lives here. Order is document
   * order (region, regionId, paragraphIndex, startOffset).
   */
  additionalRanges?: AnchorRange[];
};

export type CanonicalCommentStatus = "open" | "addressed" | "wontfix" | "superseded";

/**
 * What kind of doc annotation produced this canonical_comment.
 *
 * - `comment`: a Drive comment thread (or reply within one). Author/timestamp from the API.
 * - `suggestion_insert` / `suggestion_delete`: a Google Docs tracked-change suggestion.
 *   Author/timestamp for the suggestion aren't surfaced by `documents.get`; resolving
 *   them via the Drive revisions API is deferred (SPEC Phase 6). Reply threads typed
 *   into the suggestion's sidebar entry are stored internally by Google and are not
 *   exposed by any public API — verified empirically. Use `bun margin inspect <url>`
 *   to confirm if you suspect a doc has discussion that's not making it through.
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
    originTimestamp: integer("origin_timestamp", { mode: "timestamp_ms" }).notNull(),
    kind: text("kind").$type<CanonicalCommentKind>().notNull().default("comment"),
    anchor: text("anchor", { mode: "json" }).$type<CommentAnchor>().notNull(),
    body: text("body").notNull(),
    status: text("status").$type<CanonicalCommentStatus>().notNull().default("open"),
    parentCommentId: text("parent_comment_id"),
    /**
     * DOM-side discussion thread id from the Docs canvas sidebar (e.g.
     * `kix.<n>`). Populated by the browser-extension capture role (Phase 2)
     * when a row corresponds to an observed sidebar thread; null for
     * comments / suggestions ingested purely from public APIs.
     */
    kixDiscussionId: text("kix_discussion_id"),
    /**
     * Extension-side stable id used for idempotent capture POSTs. Unique per
     * (origin_version_id, external_id) — see `canonical_comment_capture_idx`.
     */
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("canonical_comment_project_idx").on(t.projectId),
    index("canonical_comment_kix_idx").on(t.originVersionId, t.kixDiscussionId),
    index("canonical_comment_capture_idx").on(t.originVersionId, t.externalId),
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
    index("comment_projection_version_google_idx").on(t.versionId, t.googleCommentId),
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

/**
 * Active Drive `files.watch` channel for a version's Google Doc. One row per
 * (version × active channel). Operational state (not part of SPEC §4's data model);
 * the doc-watcher reads it to renew expiring channels and to map an inbound
 * push notification's channel id back to the version it covers.
 */
export const driveWatchChannel = sqliteTable(
  "drive_watch_channel",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    versionId: text("version_id")
      .notNull()
      .references(() => version.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull().unique(),
    resourceId: text("resource_id").notNull(),
    /** Random per-channel secret echoed back as `X-Goog-Channel-Token`. */
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
 * Per-user opaque API tokens. The plaintext is `mgn_<base64url(32 bytes)>`
 * and is shown to the user exactly once at issue time; the DB stores only a
 * SHA-256 hash. 32 bytes of randomness gives ~256 bits of entropy, so a
 * single-pass hash is sufficient — no key-stretch needed (these aren't
 * passwords). Use `tokenPreview` for display in management UI ("mgn_xxxx…").
 */
export const apiToken = sqliteTable(
  "api_token",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPreview: text("token_preview").notNull(),
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("api_token_user_idx").on(t.userId)],
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
