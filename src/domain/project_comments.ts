import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  canonicalComment,
  commentProjection,
  type ProjectionStatus,
} from "../db/schema.ts";
import { tokenProviderForProject } from "./project.ts";
import { requireVersion } from "./version.ts";
import { getDocument } from "../google/docs.ts";
import { reanchor, type ReanchorResult } from "./reanchor.ts";

type CanonicalComment = typeof canonicalComment.$inferSelect;

export interface ProjectionDetail {
  canonicalComment: CanonicalComment;
  result: ReanchorResult;
}

export interface ProjectionRunResult {
  versionId: string;
  scanned: number;
  /** Newly inserted projection rows (no prior row for this canonical → version pair). */
  inserted: number;
  /** Existing rows where status or confidence changed and we updated the row. */
  updated: number;
  /** Existing rows where the projection was unchanged. */
  unchanged: number;
  byStatus: Record<ProjectionStatus, number>;
  details: ProjectionDetail[];
}

/**
 * Project every canonical_comment in `targetVersion`'s project onto the target version.
 * Skips comments that originated on this version (their projection row was created at
 * ingest time) and rows already marked `manually_resolved`. Idempotent — re-running on
 * an unchanged target reports `unchanged` for every row.
 */
export async function projectCommentsOntoVersion(
  targetVersionId: string,
): Promise<ProjectionRunResult> {
  const ver = await requireVersion(targetVersionId);
  const tp = await tokenProviderForProject(ver.projectId);
  const doc = await getDocument(tp, ver.googleDocId);

  const comments = await db
    .select()
    .from(canonicalComment)
    .where(
      and(
        eq(canonicalComment.projectId, ver.projectId),
        ne(canonicalComment.originVersionId, targetVersionId),
      ),
    );

  const result: ProjectionRunResult = {
    versionId: targetVersionId,
    scanned: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    byStatus: { clean: 0, fuzzy: 0, orphaned: 0, manually_resolved: 0 },
    details: [],
  };

  for (const cc of comments) {
    result.scanned++;
    const r = reanchor(doc, cc.anchor);
    result.details.push({ canonicalComment: cc, result: r });
    const existing = (
      await db
        .select()
        .from(commentProjection)
        .where(
          and(
            eq(commentProjection.canonicalCommentId, cc.id),
            eq(commentProjection.versionId, targetVersionId),
          ),
        )
        .limit(1)
    )[0];

    if (existing?.projectionStatus === "manually_resolved") {
      result.unchanged++;
      result.byStatus.manually_resolved++;
      continue;
    }

    if (!existing) {
      await db.insert(commentProjection).values({
        canonicalCommentId: cc.id,
        versionId: targetVersionId,
        anchorMatchConfidence: r.confidence,
        projectionStatus: r.status,
      });
      result.inserted++;
      result.byStatus[r.status]++;
      continue;
    }

    if (
      existing.projectionStatus === r.status &&
      existing.anchorMatchConfidence === r.confidence
    ) {
      result.unchanged++;
      result.byStatus[r.status]++;
      continue;
    }

    await db
      .update(commentProjection)
      .set({
        anchorMatchConfidence: r.confidence,
        projectionStatus: r.status,
        lastSyncedAt: new Date(),
      })
      .where(
        and(
          eq(commentProjection.canonicalCommentId, cc.id),
          eq(commentProjection.versionId, targetVersionId),
        ),
      );
    result.updated++;
    result.byStatus[r.status]++;
  }

  return result;
}
