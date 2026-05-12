import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  auditLog,
  reviewActionToken,
  reviewAssignment,
  type ReviewActionKind,
  type ReviewAssignmentStatus,
} from "../db/schema.ts";
import { paragraphHash } from "./anchor.ts";

/**
 * Magic-link review actions (SPEC §6.3 + §12 Phase 4). One row in
 * `review_action_token` per (assignment, action) pair — the email body
 * embeds four links and each redeems to one of these. Tokens are
 * single-use: `redeemReviewActionToken` checks `used_at`, applies the
 * assignment state change, then marks the token used inside the same
 * transaction's worth of writes.
 *
 * The plaintext token is `mra_<base64url(32 bytes)>` — 32 bytes of
 * randomness gives ~256 bits of entropy, so a single sha256 of the
 * plaintext is sufficient (these aren't passwords; brute-force is
 * already implausible). Plaintext is shown to the email recipient
 * only — the DB stores `token_hash`.
 */
export const REVIEW_ACTION_TOKEN_PREFIX = "mra_";
const RANDOM_BYTES = 32;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface IssuedReviewActionToken {
  /** Plaintext token. Embed in the email link; not persisted. */
  token: string;
  tokenId: string;
  expiresAt: Date;
}

export async function issueReviewActionToken(opts: {
  reviewRequestId: string;
  assigneeUserId: string;
  action: ReviewActionKind;
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
      action: opts.action,
      expiresAt,
    })
    .returning({ id: reviewActionToken.id });
  return { token, tokenId: inserted[0]!.id, expiresAt };
}

export type RedeemOutcome =
  | { ok: true; action: ReviewActionKind; assignmentStatus: ReviewAssignmentStatus }
  | { ok: false; reason: "invalid" | "expired" | "already_used" | "assignment_missing" };

export async function redeemReviewActionToken(
  plaintext: string,
): Promise<RedeemOutcome> {
  if (!plaintext || !plaintext.startsWith(REVIEW_ACTION_TOKEN_PREFIX)) {
    return { ok: false, reason: "invalid" };
  }
  // Single transaction so the "check usedAt, then mark used" pair is atomic.
  // Without this, two concurrent redemptions of the same link could both
  // pass the !usedAt check and double-fire the audit log + status change.
  return db.transaction((tx): RedeemOutcome => {
    const rows = tx
      .select()
      .from(reviewActionToken)
      .where(eq(reviewActionToken.tokenHash, paragraphHash(plaintext)))
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) return { ok: false, reason: "invalid" };
    if (row.usedAt) return { ok: false, reason: "already_used" };
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

    // Claim the token first with a conditional update; if zero rows match
    // (because a parallel redemption just set used_at), bail out as
    // already_used. After this point we hold the exclusive right to apply
    // the side effects for this token.
    const claimed = tx
      .update(reviewActionToken)
      .set({ usedAt: new Date() })
      .where(
        and(eq(reviewActionToken.id, row.id), isNull(reviewActionToken.usedAt)),
      )
      .returning({ id: reviewActionToken.id })
      .all();
    if (claimed.length === 0) {
      return { ok: false, reason: "already_used" };
    }

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

    const nextStatus = nextAssignmentStatus(row.action, assignment.status);

    // Record the response on every successful redemption, even when the
    // action leaves `status` unchanged (`accept_reconciliation` is the
    // pure-acknowledgement case — without this, UI joins keyed on
    // `responded_at` never see the assignee actually responded).
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
      action: `review_action.${row.action}`,
      targetType: "review_assignment",
      targetId: `${assignment.reviewRequestId}:${assignment.userId}`,
      before: { status: assignment.status },
      after: { status: nextStatus },
    }).run();

    return { ok: true, action: row.action, assignmentStatus: nextStatus };
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

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

