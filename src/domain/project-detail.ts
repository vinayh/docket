import { getProject } from "./project.ts";
import { listVersions, type Version } from "./version.ts";
import { listDerivatives, type Derivative } from "./overlay.ts";
import {
  countCommentsByOriginVersion,
  pickLastSyncedAtByVersion,
} from "./stats.ts";
import { listOpenReviewRequests, type ReviewRequest } from "./review.ts";
import { userEmailById } from "./user.ts";

/**
 * Composed dashboard view for a single project. Drives the extension
 * side-panel project view: header (parent doc, owner), versions table
 * (with per-version comment count + last-synced), derivatives, and open
 * review requests.
 *
 * `getProjectDetail` returns null when the project doesn't exist OR the
 * caller is not the owner — surfacing the difference would leak existence
 * across tenants (same rule as `getDocState`'s cross-user `tracked: false`).
 * Routes turn null into 404.
 */
export interface ProjectDetail {
  project: {
    id: string;
    parentDocId: string;
    ownerEmail: string | null;
    createdAt: number;
  };
  versions: VersionDetail[];
  derivatives: DerivativeDetail[];
  reviewRequests: ReviewRequestDetail[];
}

export interface VersionDetail {
  id: string;
  label: string;
  googleDocId: string;
  status: "active" | "archived";
  parentVersionId: string | null;
  createdAt: number;
  commentCount: number;
  lastSyncedAt: number | null;
}

export interface DerivativeDetail {
  id: string;
  versionId: string;
  overlayId: string;
  googleDocId: string;
  audienceLabel: string | null;
  createdAt: number;
}

export interface ReviewRequestDetail {
  id: string;
  versionId: string;
  status: "open" | "closed" | "cancelled";
  deadline: number | null;
  createdAt: number;
}

export async function getProjectDetail(opts: {
  projectId: string;
  userId: string;
}): Promise<ProjectDetail | null> {
  const proj = await getProject(opts.projectId);
  if (!proj || proj.ownerUserId !== opts.userId) return null;

  const versions = await listVersions(proj.id);
  const versionIds = versions.map((v) => v.id);
  const commentCounts = await countCommentsByOriginVersion(proj.id);
  const lastSynced = await pickLastSyncedAtByVersion(versionIds);
  const derivatives = await listDerivatives(proj.id);
  const reviewRequests = await listOpenReviewRequests(proj.id);
  const ownerEmail = await userEmailById(proj.ownerUserId);

  return {
    project: {
      id: proj.id,
      parentDocId: proj.parentDocId,
      ownerEmail,
      createdAt: proj.createdAt.getTime(),
    },
    versions: versions.map((v) => versionDetail(v, commentCounts, lastSynced)),
    derivatives: derivatives.map(derivativeDetail),
    reviewRequests: reviewRequests.map(reviewRequestDetail),
  };
}

function versionDetail(
  v: Version,
  commentCounts: Map<string, number>,
  lastSynced: Map<string, number | null>,
): VersionDetail {
  return {
    id: v.id,
    label: v.label,
    googleDocId: v.googleDocId,
    status: v.status,
    parentVersionId: v.parentVersionId,
    createdAt: v.createdAt.getTime(),
    commentCount: commentCounts.get(v.id) ?? 0,
    lastSyncedAt: lastSynced.get(v.id) ?? null,
  };
}

function derivativeDetail(d: Derivative): DerivativeDetail {
  return {
    id: d.id,
    versionId: d.versionId,
    overlayId: d.overlayId,
    googleDocId: d.googleDocId,
    audienceLabel: d.audienceLabel,
    createdAt: d.createdAt.getTime(),
  };
}

function reviewRequestDetail(r: ReviewRequest): ReviewRequestDetail {
  return {
    id: r.id,
    versionId: r.versionId,
    status: r.status,
    deadline: r.deadline?.getTime() ?? null,
    createdAt: r.createdAt.getTime(),
  };
}

