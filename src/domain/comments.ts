import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  canonicalComment,
  commentProjection,
  user,
  version,
  type CanonicalCommentKind,
  type CommentAnchor,
  type ProjectionStatus,
} from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import {
  listComments,
  type DriveComment,
  type DriveCommentReply,
} from "../google/drive.ts";
import { getDocument } from "../google/docs.ts";
import { getProject } from "./project.ts";
import { buildAnchor, orphanAnchor, paragraphHash } from "./anchor.ts";
import { extractSuggestions, type SuggestionSpan } from "./suggestions.ts";

export type CanonicalComment = typeof canonicalComment.$inferSelect;

export interface IngestResult {
  versionId: string;
  fetched: number;
  inserted: number;
  alreadyPresent: number;
  skipped: number;
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
  const ver = (
    await db.select().from(version).where(eq(version.id, versionId)).limit(1)
  )[0];
  if (!ver) throw new Error(`version ${versionId} not found`);

  const proj = await getProject(ver.projectId);
  if (!proj) throw new Error(`project ${ver.projectId} not found for version ${versionId}`);

  const tp = tokenProviderForUser(proj.ownerUserId);
  const [doc, comments] = await Promise.all([
    getDocument(tp, ver.googleDocId),
    listComments(tp, ver.googleDocId),
  ]);

  const result: IngestResult = {
    versionId,
    fetched: 0,
    inserted: 0,
    alreadyPresent: 0,
    skipped: 0,
    suggestionsInserted: 0,
  };

  for (const c of comments) {
    if (c.deleted) {
      result.skipped++;
      continue;
    }
    result.fetched++;

    const anchor = anchorForComment(doc, c);
    const parentCanonical = await upsertOne({
      projectId: ver.projectId,
      versionId,
      googleCommentId: c.id,
      kind: "comment",
      author: c.author,
      createdTime: c.createdTime,
      body: c.content,
      anchor,
      parentCommentId: null,
      result,
    });

    for (const reply of c.replies ?? []) {
      if (reply.deleted) {
        result.skipped++;
        continue;
      }
      result.fetched++;
      await upsertOne({
        projectId: ver.projectId,
        versionId,
        googleCommentId: reply.id,
        kind: "comment",
        author: reply.author,
        createdTime: reply.createdTime,
        body: reply.content,
        anchor,
        parentCommentId: parentCanonical,
        result,
      });
    }
  }

  for (const sug of extractSuggestions(doc)) {
    result.fetched++;
    const insertedBefore = result.inserted;
    await upsertOne({
      projectId: ver.projectId,
      versionId,
      googleCommentId: sug.id,
      kind: sug.kind,
      author: undefined,
      createdTime: new Date().toISOString(),
      body: suggestionBody(sug),
      anchor: suggestionAnchor(sug),
      parentCommentId: null,
      result,
    });
    if (result.inserted > insertedBefore) result.suggestionsInserted++;
  }

  return result;
}

function suggestionBody(s: SuggestionSpan): string {
  return s.kind === "suggestion_insert"
    ? `[suggested insertion] ${s.text}`
    : `[suggested deletion] ${s.text}`;
}

function suggestionAnchor(s: SuggestionSpan): CommentAnchor {
  const CONTEXT = 32;
  const before = s.paragraphText.slice(Math.max(0, s.offset - CONTEXT), s.offset);
  const afterStart = s.offset + s.length;
  const after = s.paragraphText.slice(afterStart, afterStart + CONTEXT);
  return {
    quotedText: s.text,
    contextBefore: before || undefined,
    contextAfter: after || undefined,
    paragraphHash: paragraphHash(s.paragraphText),
    structuralPosition: {
      region: s.region,
      ...(s.region !== "body" ? { regionId: s.regionId } : {}),
      paragraphIndex: s.paragraphIndex,
      offset: s.offset,
    },
  };
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

  const originUserId = args.author?.emailAddress
    ? (
        await db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, args.author.emailAddress))
          .limit(1)
      )[0]?.id ?? null
    : null;

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
