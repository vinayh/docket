import { and, count, eq, inArray, max } from "drizzle-orm";
import { db } from "../db/client.ts";
import { canonicalComment, reviewRequest, version } from "../db/schema.ts";

/**
 * Project- and version-scoped aggregation helpers shared between
 * `doc-state` (per-doc tracked? lookup) and `project-detail` (whole-project
 * dashboard).
 */

/**
 * "Last synced" timestamp for a version. Sourced from `version.lastSyncedAt`,
 * which `ingestVersionComments` stamps on every successful run regardless of
 * whether any comments were found. Returns null when the version has never
 * been ingested.
 */
export async function pickLastSyncedAt(versionId: string): Promise<number | null> {
  const rows = await db
    .select({ ts: version.lastSyncedAt })
    .from(version)
    .where(eq(version.id, versionId))
    .limit(1);
  return rows[0]?.ts?.getTime() ?? null;
}

/**
 * Batched form of `pickLastSyncedAt`. One query against `version`. Use when
 * rendering a list of versions (dashboard) to avoid N+1.
 */
export async function pickLastSyncedAtByVersion(
  versionIds: readonly string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (versionIds.length === 0) return out;

  for (const id of versionIds) out.set(id, null);

  const rows = await db
    .select({ id: version.id, ts: version.lastSyncedAt })
    .from(version)
    .where(inArray(version.id, versionIds as string[]));
  for (const row of rows) {
    out.set(row.id, row.ts?.getTime() ?? null);
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

/**
 * Per-project version count, keyed by `project_id`. Used by the Options
 * page's "Connected docs" list — one query is cheaper than N round-trips
 * even at small project counts, and the index on `version.project_id`
 * makes the grouped scan linear in row count.
 */
export async function countVersionsByProject(
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (projectIds.length === 0) return out;
  for (const id of projectIds) out.set(id, 0);
  const rows = await db
    .select({ projectId: version.projectId, n: count() })
    .from(version)
    .where(inArray(version.projectId, projectIds as string[]))
    .groupBy(version.projectId);
  for (const row of rows) out.set(row.projectId, row.n);
  return out;
}

/**
 * Per-project last-synced timestamp — max of `version.lastSyncedAt` across
 * the project's versions. Mirrors `pickLastSyncedAtByVersion` at the
 * project-rollup level.
 */
export async function pickLastSyncedAtByProject(
  projectIds: readonly string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (projectIds.length === 0) return out;
  for (const id of projectIds) out.set(id, null);
  const rows = await db
    .select({ projectId: version.projectId, ts: max(version.lastSyncedAt) })
    .from(version)
    .where(inArray(version.projectId, projectIds as string[]))
    .groupBy(version.projectId);
  for (const row of rows) out.set(row.projectId, row.ts?.getTime() ?? null);
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
