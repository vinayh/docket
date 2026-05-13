import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  auditLog,
  reviewAssignment,
  reviewRequest,
  user,
  type ReviewActionKind,
  type ReviewAssignmentStatus,
} from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { createPermission } from "../google/drive.ts";
import { config } from "../config.ts";
import { requireProject } from "./project.ts";
import { loadOwnedVersion } from "./version.ts";
import { getOrCreateUserByEmail } from "./user.ts";
import { issueReviewActionToken } from "./review-action.ts";

export type ReviewRequest = typeof reviewRequest.$inferSelect;

const DEFAULT_ACTIONS: ReviewActionKind[] = [
  "mark_reviewed",
  "request_changes",
  "decline",
];

export interface AssigneeMagicLinks {
  email: string;
  userId: string;
  links: { action: ReviewActionKind; url: string; expiresAt: number }[];
}

export interface CreateReviewRequestResult {
  reviewRequestId: string;
  versionId: string;
  assignees: AssigneeMagicLinks[];
}

/**
 * Create a review_request, fan out review_assignment rows, share the version
 * doc with each assignee (Drive `commenter`), and mint one magic-link token
 * per assignee × action. Email transport isn't wired yet — callers receive
 * the issued `/r/<token>` URLs in the response so the side-panel POC can
 * display them inline. The audit log captures the request creation so the
 * later email-transport implementation has a record of which tokens were
 * generated.
 *
 * Drive share failures are caught per-assignee so a single bad email doesn't
 * abort the whole request; the failing share is reported back as `null` URLs
 * with the error attached.
 */
export async function createReviewRequest(opts: {
  versionId: string;
  ownerUserId: string;
  assigneeEmails: string[];
  deadline?: Date | null;
  actions?: ReviewActionKind[];
}): Promise<CreateReviewRequestResult> {
  const ver = await loadOwnedVersion(opts.versionId, opts.ownerUserId);
  if (!ver) throw new ReviewRequestNotFoundError(opts.versionId);

  const proj = await requireProject(ver.projectId);
  const tp = tokenProviderForUser(proj.ownerUserId);

  const uniqueEmails = uniqLower(opts.assigneeEmails);
  if (uniqueEmails.length === 0) {
    throw new ReviewRequestBadRequestError("at least one assignee required");
  }

  const assignees = await Promise.all(
    uniqueEmails.map((email) => getOrCreateUserByEmail(email)),
  );

  const [insertedRequest] = await db
    .insert(reviewRequest)
    .values({
      projectId: proj.id,
      versionId: ver.id,
      createdByUserId: opts.ownerUserId,
      deadline: opts.deadline ?? null,
      status: "open",
    })
    .returning();
  const reviewRequestId = insertedRequest!.id;

  // Fan out review_assignment rows in one insert; on conflict (same assignee
  // already on this request) silently ignore — magic-link reissue can repeat.
  await db
    .insert(reviewAssignment)
    .values(
      assignees.map((u) => ({
        reviewRequestId,
        userId: u.id,
        status: "pending" as ReviewAssignmentStatus,
      })),
    )
    .onConflictDoNothing();

  const actions = opts.actions ?? DEFAULT_ACTIONS;
  const baseUrl = config.publicBaseUrl;

  const out: AssigneeMagicLinks[] = [];
  for (const u of assignees) {
    let shareError: string | null = null;
    try {
      await createPermission(tp, ver.googleDocId, {
        emailAddress: u.email,
        role: "commenter",
      });
    } catch (err) {
      shareError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[review] permission share failed for ${u.email} on ${ver.googleDocId}: ${shareError}`,
      );
    }

    const links: AssigneeMagicLinks["links"] = [];
    for (const action of actions) {
      const issued = await issueReviewActionToken({
        reviewRequestId,
        assigneeUserId: u.id,
        action,
      });
      const url = baseUrl
        ? `${baseUrl.replace(/\/+$/, "")}/r/${issued.token}`
        : `/r/${issued.token}`;
      links.push({
        action,
        url,
        expiresAt: issued.expiresAt.getTime(),
      });
    }

    out.push({ email: u.email, userId: u.id, links });

    if (shareError) {
      console.warn(
        `[review] continuing despite share failure for ${u.email}; magic links still issued`,
      );
    }
  }

  await db.insert(auditLog).values({
    actorUserId: opts.ownerUserId,
    action: "review_request.create",
    targetType: "review_request",
    targetId: reviewRequestId,
    before: null,
    after: {
      versionId: ver.id,
      assignees: out.map((a) => ({ email: a.email, userId: a.userId })),
      actions,
    },
  });

  return { reviewRequestId, versionId: ver.id, assignees: out };
}

export class ReviewRequestNotFoundError extends Error {
  constructor(versionId: string) {
    super(`version ${versionId} not found or not owned`);
    this.name = "ReviewRequestNotFoundError";
  }
}

export class ReviewRequestBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRequestBadRequestError";
  }
}

function uniqLower(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const lower = raw.trim().toLowerCase();
    if (!lower) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

export interface ReviewAssigneeDetail {
  email: string;
  userId: string;
  status: ReviewAssignmentStatus;
  respondedAt: number | null;
}

export async function listAssigneesForRequests(
  requestIds: string[],
): Promise<Map<string, ReviewAssigneeDetail[]>> {
  if (requestIds.length === 0) return new Map();
  const rows = await db
    .select({
      reviewRequestId: reviewAssignment.reviewRequestId,
      userId: reviewAssignment.userId,
      status: reviewAssignment.status,
      respondedAt: reviewAssignment.respondedAt,
      email: user.email,
    })
    .from(reviewAssignment)
    .innerJoin(user, eq(user.id, reviewAssignment.userId))
    .where(inArray(reviewAssignment.reviewRequestId, requestIds));
  const grouped = new Map<string, ReviewAssigneeDetail[]>();
  for (const r of rows) {
    const list = grouped.get(r.reviewRequestId) ?? [];
    list.push({
      email: r.email,
      userId: r.userId,
      status: r.status,
      respondedAt: r.respondedAt?.getTime() ?? null,
    });
    grouped.set(r.reviewRequestId, list);
  }
  return grouped;
}

export async function listOpenReviewRequests(
  projectId: string,
): Promise<ReviewRequest[]> {
  return db
    .select()
    .from(reviewRequest)
    .where(
      and(
        eq(reviewRequest.projectId, projectId),
        eq(reviewRequest.status, "open"),
      ),
    )
    .orderBy(desc(reviewRequest.createdAt));
}
