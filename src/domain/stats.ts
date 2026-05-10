import { and, count, eq, inArray, max } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  canonicalComment,
  commentProjection,
  driveWatchChannel,
  reviewRequest,
} from "../db/schema.ts";

/**
 * Project- and version-scoped aggregation helpers shared between
 * `doc-state` (per-doc tracked? lookup) and `project-detail` (whole-project
 * dashboard). Extracted from `domain/doc-state.ts` when the second consumer
 * landed — keeping them here avoids two diverging "best available
 * lastSyncedAt" / "count canonical comments" implementations.
 */

/**
 * Best available "last synced" signal for a version: prefer the watch
 * channel's `lastSyncedAt` (set when an inbound push triggered an ingest)
 * and fall back to the max projection `lastSyncedAt` (set by polling).
 * Either source maxes out at the most recent successful comment-ingest run.
 * Returns `null` when neither table has a row for the version.
 */
export async function pickLastSyncedAt(versionId: string): Promise<number | null> {
  const watch = (
    await db
      .select({ ts: max(driveWatchChannel.lastSyncedAt) })
      .from(driveWatchChannel)
      .where(eq(driveWatchChannel.versionId, versionId))
  )[0]?.ts;
  const projection = (
    await db
      .select({ ts: max(commentProjection.lastSyncedAt) })
      .from(commentProjection)
      .where(eq(commentProjection.versionId, versionId))
  )[0]?.ts;
  return pickMaxDate(watch ?? null, projection ?? null);
}

/**
 * Batched form of `pickLastSyncedAt` — one query each against the watch
 * channel and projection tables, both grouped by version. Use when rendering
 * a list of versions (dashboard) to avoid N+1.
 */
export async function pickLastSyncedAtByVersion(
  versionIds: readonly string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (versionIds.length === 0) return out;

  for (const id of versionIds) out.set(id, null);

  const watchRows = await db
    .select({
      versionId: driveWatchChannel.versionId,
      ts: max(driveWatchChannel.lastSyncedAt),
    })
    .from(driveWatchChannel)
    .where(inArray(driveWatchChannel.versionId, versionIds as string[]))
    .groupBy(driveWatchChannel.versionId);
  for (const row of watchRows) {
    out.set(row.versionId, pickMaxDate(out.get(row.versionId) ?? null, row.ts ?? null));
  }

  const projRows = await db
    .select({
      versionId: commentProjection.versionId,
      ts: max(commentProjection.lastSyncedAt),
    })
    .from(commentProjection)
    .where(inArray(commentProjection.versionId, versionIds as string[]))
    .groupBy(commentProjection.versionId);
  for (const row of projRows) {
    out.set(row.versionId, pickMaxDate(out.get(row.versionId) ?? null, row.ts ?? null));
  }

  return out;
}

export async function countComments(projectId: string): Promise<number> {
  const row = (
    await db
      .select({ n: count() })
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, projectId))
  )[0];
  return row?.n ?? 0;
}

/**
 * Per-version comment count, keyed by `origin_version_id` — i.e. comments
 * that originated on that version, not projections onto it. Matches the
 * mental model of the project dashboard ("how much discussion did v2
 * generate") rather than the projection table's "how much discussion exists
 * on v3 once you've ingested v2 + v1's comments forward."
 */
export async function countCommentsByOriginVersion(
  projectId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      versionId: canonicalComment.originVersionId,
      n: count(),
    })
    .from(canonicalComment)
    .where(eq(canonicalComment.projectId, projectId))
    .groupBy(canonicalComment.originVersionId);
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.versionId, row.n);
  return out;
}

export async function countOpenReviews(projectId: string): Promise<number> {
  const row = (
    await db
      .select({ n: count() })
      .from(reviewRequest)
      .where(
        and(
          eq(reviewRequest.projectId, projectId),
          eq(reviewRequest.status, "open"),
        ),
      )
  )[0];
  return row?.n ?? 0;
}

function pickMaxDate(a: Date | number | null, b: Date | number | null): number | null {
  const am = a instanceof Date ? a.getTime() : a;
  const bm = b instanceof Date ? b.getTime() : b;
  if (am === null && bm === null) return null;
  if (am === null) return bm;
  if (bm === null) return am;
  return am > bm ? am : bm;
}
