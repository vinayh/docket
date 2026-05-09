import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  canonicalComment,
  commentProjection,
  type CanonicalCommentKind,
  type CommentAnchor,
  type ProjectionStatus,
} from "../db/schema.ts";
import {
  listComments,
  type DriveComment,
  type DriveCommentReply,
} from "../google/drive.ts";
import { getDocument, type Document } from "../google/docs.ts";
import { tokenProviderForProject } from "./project.ts";
import { requireVersion } from "./version.ts";
import { userIdByEmail } from "./user.ts";
import { anchorAt, buildAnchor, orphanAnchor } from "./anchor.ts";
import { extractSuggestions, type SuggestionSpan } from "./suggestions.ts";

export type CanonicalComment = typeof canonicalComment.$inferSelect;

export interface IngestResult {
  versionId: string;
  fetched: number;
  inserted: number;
  alreadyPresent: number;
  /**
   * Drive comments / replies marked `deleted: true` by Google. We don't
   * project those into the canonical store. Currently the only "skipped"
   * source; named explicitly so future skip categories don't accidentally
   * collapse into the same counter.
   */
  skippedDeleted: number;
  /** Subset of `inserted` that were tracked-change suggestions (insert + delete). */
  suggestionsInserted: number;
}

/**
 * Pull every Drive comment (and reply) on a version's Google Doc, normalize each into
 * a canonical_comment, and record a comment_projection row tying the canonical comment
 * back to its source Drive comment on that version. Idempotent: re-running on the same
 * version skips comments already projected onto it.
 *
 * Per SPEC §5, the anchor stored on canonical_comment is Docket's own (quoted text +
 * paragraph hash + structural offset). The kix anchor blob in `comment.anchor` is
 * intentionally ignored on ingest — quoted_file_content.value is what we anchor against.
 */
export async function ingestVersionComments(versionId: string): Promise<IngestResult> {
  const ver = await requireVersion(versionId);
  const tp = await tokenProviderForProject(ver.projectId);

  const result: IngestResult = {
    versionId,
    fetched: 0,
    inserted: 0,
    alreadyPresent: 0,
    skippedDeleted: 0,
    suggestionsInserted: 0,
  };

  const [doc, driveComments] = await Promise.all([
    getDocument(tp, ver.googleDocId),
    listComments(tp, ver.googleDocId),
  ]);

  await ingestDriveComments({
    projectId: ver.projectId,
    versionId,
    doc,
    comments: driveComments,
    result,
  });
  await ingestDocSuggestions({
    projectId: ver.projectId,
    versionId,
    doc,
    result,
  });
  return result;
}

interface PhaseArgs {
  projectId: string;
  versionId: string;
  doc: Document;
  result: IngestResult;
}

/**
 * Phase 1: Drive `comments.list` → canonical_comment (kind=comment) for each
 * top-level comment, plus one row per non-deleted reply parented to it. The
 * anchor is computed once per top-level comment and reused for its replies
 * (replies don't carry their own quoted text in the Drive API response).
 */
async function ingestDriveComments(
  args: PhaseArgs & { comments: DriveComment[] },
): Promise<void> {
  for (const c of args.comments) {
    if (c.deleted) {
      args.result.skippedDeleted++;
      continue;
    }
    args.result.fetched++;

    const anchor = anchorForComment(args.doc, c);
    const parentCanonical = await upsertOne({
      projectId: args.projectId,
      versionId: args.versionId,
      googleCommentId: c.id,
      kind: "comment",
      author: c.author,
      createdTime: c.createdTime,
      body: c.content,
      anchor,
      parentCommentId: null,
      result: args.result,
    });

    for (const reply of c.replies ?? []) {
      if (reply.deleted) {
        args.result.skippedDeleted++;
        continue;
      }
      args.result.fetched++;
      await upsertOne({
        projectId: args.projectId,
        versionId: args.versionId,
        googleCommentId: reply.id,
        kind: "comment",
        author: reply.author,
        createdTime: reply.createdTime,
        body: reply.content,
        anchor,
        parentCommentId: parentCanonical,
        result: args.result,
      });
    }
  }
}

/**
 * Phase 2: Docs API `documents.get` (with SUGGESTIONS_INLINE) → one
 * canonical_comment per tracked-change span, kind=`suggestion_insert` /
 * `suggestion_delete`. Author + timestamp aren't surfaced by the Docs API
 * (deferred to Phase 6 via Drive `revisions.list` cross-reference), so we
 * stamp ingestion time and a null author per SPEC §11.
 */
async function ingestDocSuggestions(args: PhaseArgs): Promise<void> {
  for (const sug of extractSuggestions(args.doc)) {
    args.result.fetched++;
    const insertedBefore = args.result.inserted;
    await upsertOne({
      projectId: args.projectId,
      versionId: args.versionId,
      googleCommentId: sug.id,
      kind: sug.kind,
      author: undefined,
      createdTime: new Date().toISOString(),
      body: suggestionBody(sug),
      anchor: suggestionAnchor(sug),
      parentCommentId: null,
      result: args.result,
    });
    if (args.result.inserted > insertedBefore) args.result.suggestionsInserted++;
  }
}

function suggestionBody(s: SuggestionSpan): string {
  return s.kind === "suggestion_insert"
    ? `[suggested insertion] ${s.text}`
    : `[suggested deletion] ${s.text}`;
}

function suggestionAnchor(s: SuggestionSpan): CommentAnchor {
  return anchorAt(
    s.text,
    {
      paragraphIndex: s.paragraphIndex,
      text: s.paragraphText,
      startIndex: 0,
      endIndex: 0,
    },
    s.offset,
    { matchLen: s.length, region: s.region, regionId: s.regionId },
  );
}

function anchorForComment(
  doc: Awaited<ReturnType<typeof getDocument>>,
  c: DriveComment,
): CommentAnchor {
  const quoted = c.quotedFileContent?.value?.trim();
  if (!quoted) return orphanAnchor("");
  return buildAnchor(doc, quoted)?.anchor ?? orphanAnchor(quoted);
}

interface UpsertArgs {
  projectId: string;
  versionId: string;
  googleCommentId: string;
  kind: CanonicalCommentKind;
  author: DriveComment["author"] | DriveCommentReply["author"] | undefined;
  createdTime: string;
  body: string;
  anchor: CommentAnchor;
  parentCommentId: string | null;
  result: IngestResult;
}

async function upsertOne(args: UpsertArgs): Promise<string> {
  const existing = await db
    .select({ canonicalId: commentProjection.canonicalCommentId })
    .from(commentProjection)
    .where(
      and(
        eq(commentProjection.versionId, args.versionId),
        eq(commentProjection.googleCommentId, args.googleCommentId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    args.result.alreadyPresent++;
    return existing[0].canonicalId;
  }

  const originUserId = await userIdByEmail(args.author?.emailAddress);

  const status: ProjectionStatus = args.anchor.structuralPosition ? "clean" : "orphaned";
  const matchConfidence = args.anchor.structuralPosition ? 100 : 0;

  const inserted = await db
    .insert(canonicalComment)
    .values({
      projectId: args.projectId,
      originVersionId: args.versionId,
      originUserId,
      originUserEmail: args.author?.emailAddress ?? null,
      originUserDisplayName: args.author?.displayName ?? null,
      originTimestamp: new Date(args.createdTime),
      kind: args.kind,
      anchor: args.anchor,
      body: args.body,
      parentCommentId: args.parentCommentId,
    })
    .returning({ id: canonicalComment.id });

  const canonicalId = inserted[0]!.id;

  await db.insert(commentProjection).values({
    canonicalCommentId: canonicalId,
    versionId: args.versionId,
    googleCommentId: args.googleCommentId,
    anchorMatchConfidence: matchConfidence,
    projectionStatus: status,
  });

  args.result.inserted++;
  return canonicalId;
}

export async function listCommentsForProject(
  projectId: string,
): Promise<CanonicalComment[]> {
  return db
    .select()
    .from(canonicalComment)
    .where(eq(canonicalComment.projectId, projectId))
    .orderBy(desc(canonicalComment.originTimestamp));
}
