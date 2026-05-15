import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  auditLog,
  reviewActionToken,
  reviewAssignment,
  type ReviewActionKind,
  type ReviewAssignmentStatus,
} from "../db/schema.ts";
import { paragraphHash } from "./anchor.ts";

// Magic-link review actions. One token per (review_request_id, assignee_user_id);
// reusable until expiry. The action is supplied at redeem time so a reviewer
// can change their response by clicking a different action link. Plaintext is
// mra_<base64url(32 bytes)>; DB stores sha256(plaintext).
export const REVIEW_ACTION_TOKEN_PREFIX = "mra_";
const RANDOM_BYTES = 32;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface IssuedReviewActionToken {
  // Plaintext. Embed in the email link; not persisted.
  token: string;
  tokenId: string;
  expiresAt: Date;
}

/**
 * Mint (or re-use) the single token for this assignee. Calling twice for the
 * same (reviewRequestId, assigneeUserId) returns the existing row's
 * `expiresAt`; the plaintext can only be returned on first mint because we
 * only store its hash.
 */
export async function issueReviewActionToken(opts: {
  reviewRequestId: string;
  assigneeUserId: string;
  ttlMs?: number;
}): Promise<IssuedReviewActionToken> {
  const random = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  const token = `${REVIEW_ACTION_TOKEN_PREFIX}${toBase64Url(random)}`;
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS));
  const inserted = await db
    .insert(reviewActionToken)
    .values({
      tokenHash: paragraphHash(token),
      reviewRequestId: opts.reviewRequestId,
      assigneeUserId: opts.assigneeUserId,
      expiresAt,
    })
    .onConflictDoNothing({
      target: [
        reviewActionToken.reviewRequestId,
        reviewActionToken.assigneeUserId,
      ],
    })
    .returning({ id: reviewActionToken.id });

  if (inserted[0]) {
    return { token, tokenId: inserted[0].id, expiresAt };
  }

  // A token already existed for this assignee. We can't surface its plaintext
  // (only the hash is stored), so callers re-issuing must accept they only
  // get a fresh URL on the first mint.
  throw new ReviewActionTokenAlreadyIssuedError(
    opts.reviewRequestId,
    opts.assigneeUserId,
  );
}

export class ReviewActionTokenAlreadyIssuedError extends Error {
  readonly reviewRequestId: string;
  readonly assigneeUserId: string;
  constructor(reviewRequestId: string, assigneeUserId: string) {
    super(
      `review action token already issued for (${reviewRequestId}, ${assigneeUserId})`,
    );
    this.name = "ReviewActionTokenAlreadyIssuedError";
    this.reviewRequestId = reviewRequestId;
    this.assigneeUserId = assigneeUserId;
  }
}

export type RedeemOutcome =
  | { ok: true; action: ReviewActionKind; assignmentStatus: ReviewAssignmentStatus }
  | { ok: false; reason: "invalid" | "expired" | "assignment_missing" };

export async function redeemReviewActionToken(
  plaintext: string,
  action: ReviewActionKind,
): Promise<RedeemOutcome> {
  if (!plaintext || !plaintext.startsWith(REVIEW_ACTION_TOKEN_PREFIX)) {
    return { ok: false, reason: "invalid" };
  }
  // The redeem is multi-use, but each redemption still needs to be atomic so
  // two concurrent clicks don't double-fire the audit log or race the state
  // transition.
  return db.transaction((tx): RedeemOutcome => {
    const rows = tx
      .select()
      .from(reviewActionToken)
      .where(eq(reviewActionToken.tokenHash, paragraphHash(plaintext)))
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) return { ok: false, reason: "invalid" };
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

    tx.update(reviewActionToken)
      .set({ lastUsedAt: new Date() })
      .where(eq(reviewActionToken.id, row.id))
      .run();

    const assignmentRows = tx
      .select()
      .from(reviewAssignment)
      .where(
        and(
          eq(reviewAssignment.reviewRequestId, row.reviewRequestId),
          eq(reviewAssignment.userId, row.assigneeUserId),
        ),
      )
      .limit(1)
      .all();
    const assignment = assignmentRows[0] ?? null;
    if (!assignment) return { ok: false, reason: "assignment_missing" };

    const nextStatus = nextAssignmentStatus(action, assignment.status);

    // Always set responded_at, even when status doesn't change (accept_reconciliation case).
    tx.update(reviewAssignment)
      .set(
        nextStatus !== assignment.status
          ? { status: nextStatus, respondedAt: new Date() }
          : { respondedAt: new Date() },
      )
      .where(
        and(
          eq(reviewAssignment.reviewRequestId, assignment.reviewRequestId),
          eq(reviewAssignment.userId, assignment.userId),
        ),
      )
      .run();

    tx.insert(auditLog).values({
      actorUserId: row.assigneeUserId,
      action: `review_action.${action}`,
      targetType: "review_assignment",
      targetId: `${assignment.reviewRequestId}:${assignment.userId}`,
      before: { status: assignment.status },
      after: { status: nextStatus },
    }).run();

    return { ok: true, action, assignmentStatus: nextStatus };
  });
}

/**
 * Map a magic-link action to the assignment status it leaves the assignment
 * in. `accept_reconciliation` doesn't change assignment state — it's a
 * cross-version comment acknowledgement (workflow §7.4 step 5) that
 * downstream code can react to via the audit log.
 */
function nextAssignmentStatus(
  action: ReviewActionKind,
  current: ReviewAssignmentStatus,
): ReviewAssignmentStatus {
  switch (action) {
    case "mark_reviewed":
      return "reviewed";
    case "decline":
      return "declined";
    case "request_changes":
      return "changes_requested";
    case "accept_reconciliation":
      return current;
  }
}

const KNOWN_ACTIONS: ReadonlySet<ReviewActionKind> = new Set([
  "mark_reviewed",
  "decline",
  "request_changes",
  "accept_reconciliation",
]);

export function parseReviewActionKind(raw: string | null): ReviewActionKind | null {
  if (!raw) return null;
  return KNOWN_ACTIONS.has(raw as ReviewActionKind)
    ? (raw as ReviewActionKind)
    : null;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
