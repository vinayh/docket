import { and, eq } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../../db/client.ts";
import {
  canonicalComment,
  commentProjection,
  type CanonicalCommentKind,
  type CommentAnchor,
  type ProjectionStatus,
} from "../../db/schema.ts";
import { userIdByEmail } from "../user.ts";
import type { IngestResult } from "./types.ts";

export interface UpsertArgs {
  projectId: string;
  versionId: string;
  /** Idempotency key recorded on `comment_projection.google_comment_id`. */
  googleCommentId: string;
  kind: CanonicalCommentKind;
  authorDisplayName: string | null;
  authorEmail: string | null;
  authorPhotoHash: string | null;
  createdIso: string;
  body: string;
  anchor: CommentAnchor;
  parentCommentId: string | null;
  result: IngestResult;
}

/**
 * Insert a canonical_comment + its origin-version comment_projection, or
 * recover the existing pair if a concurrent ingest already wrote it. The
 * unique index on `(version_id, google_comment_id)` is the backstop that
 * lets the loser of a race retry safely.
 */
export async function upsertCanonical(args: UpsertArgs): Promise<string> {
  // `userIdByEmail` hits the DB but isn't part of the upsert atomicity — pull
  // it outside the transaction so the txn callback can stay synchronous
  // (bun:sqlite transactions cannot await).
  const originUserId = await userIdByEmail(args.authorEmail);

  try {
    return db.transaction((tx) => {
      const existing = tx
        .select({ canonicalId: commentProjection.canonicalCommentId })
        .from(commentProjection)
        .where(
          and(
            eq(commentProjection.versionId, args.versionId),
            eq(commentProjection.googleCommentId, args.googleCommentId),
          ),
        )
        .limit(1)
        .all();
      if (existing[0]) {
        args.result.alreadyPresent++;
        return existing[0].canonicalId;
      }

      const status: ProjectionStatus = args.anchor.structuralPosition ? "clean" : "orphaned";
      const matchConfidence = args.anchor.structuralPosition ? 100 : 0;
      const createdAt = parseIsoOrNow(args.createdIso);

      const inserted = tx
        .insert(canonicalComment)
        .values({
          projectId: args.projectId,
          originVersionId: args.versionId,
          originUserId,
          originUserEmail: args.authorEmail,
          originUserDisplayName: args.authorDisplayName,
          originPhotoHash: args.authorPhotoHash,
          originTimestamp: createdAt,
          kind: args.kind,
          anchor: args.anchor,
          body: args.body,
          parentCommentId: args.parentCommentId,
        })
        .returning({ id: canonicalComment.id })
        .all();
      const canonicalId = inserted[0]!.id;

      // The unique index on (version_id, google_comment_id) is the backstop
      // for a concurrent ingest that committed its own projection between
      // our SELECT and INSERT. If that happens, this throws and the
      // transaction rolls back the canonical insert above; the outer catch
      // re-reads the winner.
      tx.insert(commentProjection).values({
        canonicalCommentId: canonicalId,
        versionId: args.versionId,
        googleCommentId: args.googleCommentId,
        anchorMatchConfidence: matchConfidence,
        projectionStatus: status,
      }).run();

      args.result.inserted++;
      return canonicalId;
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const winner = await db
      .select({ canonicalId: commentProjection.canonicalCommentId })
      .from(commentProjection)
      .where(
        and(
          eq(commentProjection.versionId, args.versionId),
          eq(commentProjection.googleCommentId, args.googleCommentId),
        ),
      )
      .limit(1);
    if (!winner[0]) {
      throw new Error("projection race lost but no winner row found");
    }
    args.result.alreadyPresent++;
    return winner[0].canonicalId;
  }
}

function parseIsoOrNow(iso: string): Date {
  if (!iso) return new Date();
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
