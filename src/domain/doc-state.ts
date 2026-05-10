import { and, count, desc, eq, max } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  canonicalComment,
  commentProjection,
  driveWatchChannel,
  project,
  reviewRequest,
  user,
  version,
} from "../db/schema.ts";

/**
 * Result of a popup / extension state query for the active doc.
 *
 * `tracked: false` is the no-project, no-version case — the caller renders
 * the onboarding affordance (Picker / add-on flow). When `tracked: true`,
 * `role` distinguishes:
 *   - `parent`  → the open doc IS the project's parent doc
 *   - `version` → the open doc IS one of the project's version copies
 *
 * For both, `commentCount` and `openReviewCount` are project-wide totals so
 * the popup can show lifetime activity. `lastSyncedAt` is per-relevant-version
 * (latest active for parent, the version itself for version): it answers
 * "when did Docket last refresh comments for what I'm looking at" rather
 * than the broader "when did anything sync."
 */
export type DocStateResponse =
  | { tracked: false; docId: string }
  | {
      tracked: true;
      docId: string;
      role: "parent" | "version";
      project: {
        id: string;
        parentDocId: string;
        ownerEmail: string | null;
        createdAt: number;
      };
      version: {
        id: string;
        label: string;
        googleDocId: string;
        status: "active" | "archived";
        createdAt: number;
      } | null;
      lastSyncedAt: number | null;
      commentCount: number;
      openReviewCount: number;
    };

export async function getDocState(opts: {
  docId: string;
  userId: string;
}): Promise<DocStateResponse> {
  const projectRow = (
    await db
      .select()
      .from(project)
      .where(
        and(
          eq(project.parentDocId, opts.docId),
          eq(project.ownerUserId, opts.userId),
        ),
      )
      .limit(1)
  )[0];

  if (projectRow) {
    return buildTrackedState({
      docId: opts.docId,
      role: "parent",
      projectId: projectRow.id,
      ownerUserId: projectRow.ownerUserId,
      parentDocId: projectRow.parentDocId,
      projectCreatedAt: projectRow.createdAt,
      // For a parent, "current version" = most recently created active version.
      // Falls back to most recent of any status when no active versions exist.
      preferredVersionId: null,
    });
  }

  const versionRow = (
    await db
      .select({
        v: version,
        ownerUserId: project.ownerUserId,
        parentDocId: project.parentDocId,
        projectCreatedAt: project.createdAt,
      })
      .from(version)
      .innerJoin(project, eq(project.id, version.projectId))
      .where(
        and(
          eq(version.googleDocId, opts.docId),
          eq(project.ownerUserId, opts.userId),
        ),
      )
      .limit(1)
  )[0];

  if (versionRow) {
    return buildTrackedState({
      docId: opts.docId,
      role: "version",
      projectId: versionRow.v.projectId,
      ownerUserId: versionRow.ownerUserId,
      parentDocId: versionRow.parentDocId,
      projectCreatedAt: versionRow.projectCreatedAt,
      preferredVersionId: versionRow.v.id,
    });
  }

  return { tracked: false, docId: opts.docId };
}

interface BuildArgs {
  docId: string;
  role: "parent" | "version";
  projectId: string;
  ownerUserId: string;
  parentDocId: string;
  projectCreatedAt: Date;
  /** When set, scope `version` + `lastSyncedAt` to that version row. */
  preferredVersionId: string | null;
}

async function buildTrackedState(
  args: BuildArgs,
): Promise<Extract<DocStateResponse, { tracked: true }>> {
  const ver = await pickRelevantVersion(args.projectId, args.preferredVersionId);
  const lastSynced = ver ? await pickLastSyncedAt(ver.id) : null;
  const commentCount = await countComments(args.projectId);
  const openReviewCount = await countOpenReviews(args.projectId);
  const ownerEmail = await ownerEmailFor(args.ownerUserId);

  return {
    tracked: true,
    docId: args.docId,
    role: args.role,
    project: {
      id: args.projectId,
      parentDocId: args.parentDocId,
      ownerEmail,
      createdAt: args.projectCreatedAt.getTime(),
    },
    version: ver
      ? {
          id: ver.id,
          label: ver.label,
          googleDocId: ver.googleDocId,
          status: ver.status,
          createdAt: ver.createdAt.getTime(),
        }
      : null,
    lastSyncedAt: lastSynced,
    commentCount,
    openReviewCount,
  };
}

async function pickRelevantVersion(
  projectId: string,
  preferredVersionId: string | null,
): Promise<typeof version.$inferSelect | null> {
  if (preferredVersionId) {
    const rows = await db
      .select()
      .from(version)
      .where(eq(version.id, preferredVersionId))
      .limit(1);
    return rows[0] ?? null;
  }
  const active = await db
    .select()
    .from(version)
    .where(and(eq(version.projectId, projectId), eq(version.status, "active")))
    .orderBy(desc(version.createdAt))
    .limit(1);
  if (active[0]) return active[0];
  const any = await db
    .select()
    .from(version)
    .where(eq(version.projectId, projectId))
    .orderBy(desc(version.createdAt))
    .limit(1);
  return any[0] ?? null;
}

/**
 * Best available "last synced" signal for a version: prefer the watch channel's
 * lastSyncedAt (set when an inbound push triggered an ingest) and fall back to
 * the max projection lastSyncedAt (set by polling). Either source maxes out at
 * the most recent successful comment-ingest run.
 */
async function pickLastSyncedAt(versionId: string): Promise<number | null> {
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
  const candidates: Date[] = [];
  if (watch) candidates.push(watch);
  if (projection) candidates.push(projection);
  if (candidates.length === 0) return null;
  return Math.max(...candidates.map((d) => d.getTime()));
}

async function countComments(projectId: string): Promise<number> {
  const row = (
    await db
      .select({ n: count() })
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, projectId))
  )[0];
  return row?.n ?? 0;
}

async function countOpenReviews(projectId: string): Promise<number> {
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

async function ownerEmailFor(userId: string): Promise<string | null> {
  const row = (
    await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1)
  )[0];
  return row?.email ?? null;
}
