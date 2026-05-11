import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  canonicalComment,
  commentProjection,
  version,
  type CanonicalCommentKind,
  type CanonicalCommentStatus,
  type CommentAnchor,
  type ProjectionStatus,
} from "../db/schema.ts";
import { loadOwnedVersion } from "./version.ts";

/**
 * Side-panel "comments on this version" payload (SPEC §12 Phase 4, comment-
 * reconciliation slice). The frontend renders one row per projected
 * canonical comment, with badge + action menu driven by `projection.status`
 * (`clean` / `fuzzy` / `orphaned` / `manually_resolved`).
 *
 * Source set is `comment_projection.versionId = $versionId` — comments that
 * have actually been projected onto this version. A canonical comment with
 * no projection row yet (e.g. ingested on v1, never re-projected onto v2)
 * won't appear here; the dashboard has a separate "re-project" affordance
 * for that case.
 *
 * `origin_version_id` is joined back to `version` to surface the origin
 * version's label, so the renderer can attribute cross-version comments
 * ("from v1") without a second round-trip.
 */
export interface VersionCommentsPayload {
  versionId: string;
  versionLabel: string;
  projectId: string;
  comments: VersionCommentEntry[];
}

export interface VersionCommentEntry {
  canonicalCommentId: string;
  parentCanonicalCommentId: string | null;
  kind: CanonicalCommentKind;
  body: string;
  anchor: CommentAnchor;
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

export async function getVersionCommentsPayload(opts: {
  versionId: string;
  userId: string;
}): Promise<VersionCommentsPayload | null> {
  const ver = await loadOwnedVersion(opts.versionId, opts.userId);
  if (!ver) return null;

  const rows = await db
    .select({
      cc: canonicalComment,
      cp: commentProjection,
      originVersionLabel: version.label,
    })
    .from(commentProjection)
    .innerJoin(
      canonicalComment,
      eq(canonicalComment.id, commentProjection.canonicalCommentId),
    )
    .innerJoin(version, eq(version.id, canonicalComment.originVersionId))
    .where(eq(commentProjection.versionId, opts.versionId))
    .orderBy(desc(canonicalComment.originTimestamp));

  return {
    versionId: ver.id,
    versionLabel: ver.label,
    projectId: ver.projectId,
    comments: rows.map((r) => ({
      canonicalCommentId: r.cc.id,
      parentCanonicalCommentId: r.cc.parentCommentId,
      kind: r.cc.kind,
      body: r.cc.body,
      anchor: r.cc.anchor,
      status: r.cc.status,
      originVersionId: r.cc.originVersionId,
      originVersionLabel: r.originVersionLabel,
      originUserDisplayName: r.cc.originUserDisplayName,
      originUserEmail: r.cc.originUserEmail,
      originTimestamp: r.cc.originTimestamp.getTime(),
      projection: {
        status: r.cp.projectionStatus,
        anchorMatchConfidence: r.cp.anchorMatchConfidence,
        googleCommentId: r.cp.googleCommentId,
        lastSyncedAt: r.cp.lastSyncedAt.getTime(),
      },
    })),
  };
}
