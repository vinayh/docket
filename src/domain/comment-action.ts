import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  auditLog,
  canonicalComment,
  commentProjection,
  project,
  type CanonicalCommentStatus,
  type ProjectionStatus,
} from "../db/schema.ts";
import { reanchor } from "./reanchor.ts";
import { getDocument } from "../google/docs.ts";
import { tokenProviderForProject } from "./project.ts";
import { requireVersion } from "./version.ts";

/**
 * Reconciliation actions surfaced on the side-panel comments view (SPEC §12
 * Phase 4, "Comment reconciliation actions"). One handler per action so the
 * route layer stays a thin dispatch, and so the audit-log payload is shaped
 * by the action that was actually taken.
 *
 * Authorization model: every action requires the caller to own the project
 * the canonical_comment belongs to. We collapse "no such comment" and "comment
 * not owned by caller" into the same `not_found` result so the route can map
 * to a 404 without leaking existence across tenants.
 *
 * Actions:
 *  - `accept_projection` — bless the current projection on `targetVersionId`,
 *    setting its status to `manually_resolved` and pinning confidence to 100.
 *    Used when a fuzzy / orphaned anchor is correct enough for the reviewer.
 *  - `reanchor`           — re-run the reanchoring engine against the target
 *    version's current Drive content and update the projection in place. Used
 *    when the document changed since the last projection.
 *  - `mark_resolved`      — set `canonical_comment.status = 'addressed'`.
 *  - `mark_wontfix`       — set `canonical_comment.status = 'wontfix'`.
 *  - `reopen`             — set `canonical_comment.status = 'open'`.
 */
export type CommentActionKind =
  | "accept_projection"
  | "reanchor"
  | "mark_resolved"
  | "mark_wontfix"
  | "reopen";

export interface CommentActionResult {
  canonicalCommentId: string;
  status: CanonicalCommentStatus;
  projection: {
    versionId: string;
    status: ProjectionStatus;
    anchorMatchConfidence: number | null;
  } | null;
}

export class CommentActionNotFoundError extends Error {
  constructor(message = "comment_action_not_found") {
    super(message);
    this.name = "CommentActionNotFoundError";
  }
}

export class CommentActionBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentActionBadRequestError";
  }
}

export interface PerformCommentActionArgs {
  userId: string;
  canonicalCommentId: string;
  action: CommentActionKind;
  /** Required for `accept_projection` and `reanchor`. */
  targetVersionId?: string | null;
}

/**
 * Run one of the reconciliation actions. Throws `CommentActionNotFoundError`
 * when the caller isn't the project owner or the comment doesn't exist;
 * `CommentActionBadRequestError` for shape errors the route should surface
 * as 400 (e.g. missing `targetVersionId` for an action that needs it).
 */
export async function performCommentAction(
  args: PerformCommentActionArgs,
): Promise<CommentActionResult> {
  const ctx = await loadActionContext(args.canonicalCommentId, args.userId);
  if (!ctx) throw new CommentActionNotFoundError();

  switch (args.action) {
    case "mark_resolved":
      return setCommentStatus(ctx, "addressed", args.userId);
    case "mark_wontfix":
      return setCommentStatus(ctx, "wontfix", args.userId);
    case "reopen":
      return setCommentStatus(ctx, "open", args.userId);
    case "accept_projection":
      return acceptProjection(ctx, args.targetVersionId, args.userId);
    case "reanchor":
      return reanchorProjection(ctx, args.targetVersionId, args.userId);
  }
}

interface ActionContext {
  comment: typeof canonicalComment.$inferSelect;
}

async function loadActionContext(
  commentId: string,
  userId: string,
): Promise<ActionContext | null> {
  const rows = await db
    .select({
      cc: canonicalComment,
      ownerUserId: project.ownerUserId,
    })
    .from(canonicalComment)
    .innerJoin(project, eq(project.id, canonicalComment.projectId))
    .where(eq(canonicalComment.id, commentId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.ownerUserId !== userId) return null;
  return { comment: row.cc };
}

async function setCommentStatus(
  ctx: ActionContext,
  next: CanonicalCommentStatus,
  actorUserId: string,
): Promise<CommentActionResult> {
  const before = ctx.comment.status;
  if (before === next) {
    return {
      canonicalCommentId: ctx.comment.id,
      status: before,
      projection: null,
    };
  }
  await db
    .update(canonicalComment)
    .set({ status: next })
    .where(eq(canonicalComment.id, ctx.comment.id));
  await writeAudit({
    actorUserId,
    action: `canonical_comment.${statusActionVerb(next)}`,
    targetId: ctx.comment.id,
    before: { status: before },
    after: { status: next },
  });
  return {
    canonicalCommentId: ctx.comment.id,
    status: next,
    projection: null,
  };
}

function statusActionVerb(s: CanonicalCommentStatus): string {
  switch (s) {
    case "addressed":
      return "mark_resolved";
    case "wontfix":
      return "mark_wontfix";
    case "open":
      return "reopen";
    case "superseded":
      return "supersede";
  }
}

async function acceptProjection(
  ctx: ActionContext,
  targetVersionId: string | null | undefined,
  actorUserId: string,
): Promise<CommentActionResult> {
  if (!targetVersionId) {
    throw new CommentActionBadRequestError("accept_projection requires targetVersionId");
  }
  const existing = await loadProjection(ctx.comment.id, targetVersionId);
  if (!existing) {
    throw new CommentActionNotFoundError("projection_not_found");
  }
  await db
    .update(commentProjection)
    .set({
      projectionStatus: "manually_resolved",
      anchorMatchConfidence: 100,
      lastSyncedAt: new Date(),
    })
    .where(
      and(
        eq(commentProjection.canonicalCommentId, ctx.comment.id),
        eq(commentProjection.versionId, targetVersionId),
      ),
    );
  await writeAudit({
    actorUserId,
    action: "comment_projection.accept_projection",
    targetId: `${ctx.comment.id}:${targetVersionId}`,
    before: {
      projectionStatus: existing.projectionStatus,
      anchorMatchConfidence: existing.anchorMatchConfidence,
    },
    after: {
      projectionStatus: "manually_resolved",
      anchorMatchConfidence: 100,
    },
  });
  return projectionResult(ctx.comment.id, ctx.comment.status, {
    versionId: targetVersionId,
    status: "manually_resolved",
    anchorMatchConfidence: 100,
  });
}

async function reanchorProjection(
  ctx: ActionContext,
  targetVersionId: string | null | undefined,
  actorUserId: string,
): Promise<CommentActionResult> {
  if (!targetVersionId) {
    throw new CommentActionBadRequestError("reanchor requires targetVersionId");
  }
  const ver = await requireVersion(targetVersionId).catch(() => null);
  if (!ver || ver.projectId !== ctx.comment.projectId) {
    throw new CommentActionNotFoundError("version_not_found");
  }
  const existing = await loadProjection(ctx.comment.id, targetVersionId);

  const tp = await tokenProviderForProject(ctx.comment.projectId);
  const doc = await getDocument(tp, ver.googleDocId);
  const result = reanchor(doc, ctx.comment.anchor);

  // Upsert as one statement so two concurrent reanchors against the same
  // (commentId, versionId) don't race the primary key — SQLite would throw
  // `UNIQUE constraint failed` on the second insert without this.
  await db
    .insert(commentProjection)
    .values({
      canonicalCommentId: ctx.comment.id,
      versionId: targetVersionId,
      projectionStatus: result.status,
      anchorMatchConfidence: result.confidence,
    })
    .onConflictDoUpdate({
      target: [commentProjection.canonicalCommentId, commentProjection.versionId],
      set: {
        projectionStatus: result.status,
        anchorMatchConfidence: result.confidence,
        lastSyncedAt: new Date(),
      },
    });
  await writeAudit({
    actorUserId,
    action: "comment_projection.reanchor",
    targetId: `${ctx.comment.id}:${targetVersionId}`,
    before: existing
      ? {
          projectionStatus: existing.projectionStatus,
          anchorMatchConfidence: existing.anchorMatchConfidence,
        }
      : null,
    after: {
      projectionStatus: result.status,
      anchorMatchConfidence: result.confidence,
    },
  });
  return projectionResult(ctx.comment.id, ctx.comment.status, {
    versionId: targetVersionId,
    status: result.status,
    anchorMatchConfidence: result.confidence,
  });
}

async function loadProjection(
  canonicalCommentId: string,
  versionId: string,
): Promise<typeof commentProjection.$inferSelect | null> {
  const rows = await db
    .select()
    .from(commentProjection)
    .where(
      and(
        eq(commentProjection.canonicalCommentId, canonicalCommentId),
        eq(commentProjection.versionId, versionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function projectionResult(
  canonicalCommentId: string,
  status: CanonicalCommentStatus,
  projection: NonNullable<CommentActionResult["projection"]>,
): CommentActionResult {
  return { canonicalCommentId, status, projection };
}

interface AuditArgs {
  actorUserId: string;
  action: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

async function writeAudit(args: AuditArgs): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: args.actorUserId,
    action: args.action,
    targetType: args.action.split(".")[0]!,
    targetId: args.targetId,
    before: args.before,
    after: args.after,
  });
}
