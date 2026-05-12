import type { AnchorRange, CommentAnchor } from "../../db/schema.ts";
import { listComments, exportDocx } from "../../google/drive.ts";
import {
  parseDocx,
  type DocxComment,
  type DocxRange,
} from "../../google/docx.ts";
import { tokenProviderForProject } from "../project.ts";
import { requireVersion } from "../version.ts";
import { buildAnchor } from "./anchor-build.ts";
import {
  buildAuthorIndex,
  buildDriveIndex,
  driveLookupKey,
  resolveIdentity,
  type AuthorIndex,
  type DriveEntry,
  type DriveIndex,
} from "./drive-index.ts";
import { ingestSuggestions } from "./suggestions.ts";
import { upsertCanonical } from "./upsert.ts";
import { hashShort, type IngestResult } from "./types.ts";

/**
 * Pull every annotation (comments, replies, suggestions) from a version's
 * Google Doc and normalize into canonical_comment + comment_projection rows.
 * Idempotent: re-running on the same version returns existing rows from
 * `comment_projection.google_comment_id`.
 *
 * Source of truth is the `.docx` export (SPEC §9.8) — it surfaces exact
 * anchor coordinates, disjoint multi-range comments, suggestion author +
 * timestamp, and replies on a suggestion's thread, none of which
 * `comments.list` + `documents.get` recover. `comments.list` is queried in
 * parallel only to (a) recover author email for `me === true` (OOXML drops
 * email entirely) and (b) reconstruct reply chains on plain comment threads
 * (OOXML flattens replies; the Drive API preserves the parent→reply tree).
 */
export async function ingestVersionComments(versionId: string): Promise<IngestResult> {
  const ver = await requireVersion(versionId);
  const tp = await tokenProviderForProject(ver.projectId);

  const result: IngestResult = {
    versionId,
    fetched: 0,
    inserted: 0,
    alreadyPresent: 0,
    skippedOrphanMetadata: 0,
    suggestionsInserted: 0,
  };

  const [docxBytes, driveComments] = await Promise.all([
    exportDocx(tp, ver.googleDocId),
    listComments(tp, ver.googleDocId),
  ]);
  const annotations = parseDocx(docxBytes);
  const authorIndex = buildAuthorIndex(driveComments);
  const driveIndex = buildDriveIndex(driveComments);

  // Suggestions first — comments that reply on a suggestion's thread point at
  // these canonical rows via `parent_comment_id`, so they need to exist when
  // the comment-ingest phase runs.
  const suggestionByOoxmlId = await ingestSuggestions({
    projectId: ver.projectId,
    versionId,
    suggestions: annotations.suggestions,
    authorIndex,
    result,
  });

  await ingestComments({
    projectId: ver.projectId,
    versionId,
    comments: annotations.comments,
    suggestionByOoxmlId,
    authorIndex,
    driveIndex,
    result,
  });

  return result;
}

interface CommentIngestArgs {
  projectId: string;
  versionId: string;
  comments: DocxComment[];
  /** OOXML w:id of a `<w:ins>`/`<w:del>` → canonical_comment.id of the ingested suggestion row. */
  suggestionByOoxmlId: Map<string, string>;
  authorIndex: AuthorIndex;
  driveIndex: DriveIndex;
  result: IngestResult;
}

async function ingestComments(args: CommentIngestArgs): Promise<void> {
  // Two passes: first ingest "thread roots" (comments that have no
  // overlapping suggestion AND aren't Drive replies), then ingest replies +
  // suggestion-thread comments so `parent_comment_id` references resolve.
  const driveIdToCanonical = new Map<string, string>();

  // Phase A: roots.
  for (const c of args.comments) {
    args.result.fetched++;
    const drive = lookupDrive(args.driveIndex, c);
    const isReply = drive?.parentDriveId != null;
    const isSuggestionReply = !!c.overlapsSuggestionId;
    if (isReply || isSuggestionReply) continue;
    const id = await ingestOneComment(args, c, null);
    if (drive && id) driveIdToCanonical.set(drive.driveId, id);
  }

  // Phase B: replies + suggestion-thread comments.
  for (const c of args.comments) {
    const drive = lookupDrive(args.driveIndex, c);
    const isReply = drive?.parentDriveId != null;
    const isSuggestionReply = !!c.overlapsSuggestionId;
    if (!isReply && !isSuggestionReply) continue;
    args.result.fetched++;
    let parentCanonical: string | null = null;
    if (isSuggestionReply) {
      parentCanonical = args.suggestionByOoxmlId.get(c.overlapsSuggestionId!) ?? null;
    } else if (drive?.parentDriveId) {
      parentCanonical = driveIdToCanonical.get(drive.parentDriveId) ?? null;
    }
    const id = await ingestOneComment(args, c, parentCanonical);
    if (drive && id) driveIdToCanonical.set(drive.driveId, id);
  }
}

function lookupDrive(index: DriveIndex, c: DocxComment): DriveEntry | null {
  const key = driveLookupKey(c.author, c.date);
  if (!key) return null;
  return index.byAuthorAndDate.get(key) ?? null;
}

async function ingestOneComment(
  args: CommentIngestArgs,
  c: DocxComment,
  parentCommentId: string | null,
): Promise<string | null> {
  if (c.ranges.length === 0) {
    args.result.skippedOrphanMetadata++;
    args.result.fetched--; // not actually fetched-and-ingested
    // Returning null (rather than an empty string) so the caller's drive-id
    // → canonical-id map doesn't accumulate `"" → ""` entries that would
    // then surface as a literal `parentCommentId=""` on replies pointing at
    // this orphan.
    return null;
  }
  const drive = lookupDrive(args.driveIndex, c);
  const identity = resolveIdentity(args.authorIndex, c.author);
  const externalId = drive?.driveId ?? commentIdempotencyKey(c);
  return upsertCanonical({
    projectId: args.projectId,
    versionId: args.versionId,
    googleCommentId: externalId,
    kind: "comment",
    authorDisplayName: c.author || null,
    authorEmail: identity.email,
    authorPhotoHash: identity.photoHash,
    createdIso: c.date,
    body: c.body,
    anchor: anchorFromDocxComment(c),
    parentCommentId,
    result: args.result,
  });
}

function commentIdempotencyKey(c: DocxComment): string {
  return `mgn:cmt:${hashShort(`${c.author} ${c.date} ${c.body}`)}`;
}

function anchorFromDocxComment(c: DocxComment): CommentAnchor {
  const [primary, ...rest] = c.ranges;
  if (!primary) {
    // Caller already guards on ranges.length > 0 — be defensive anyway.
    return { quotedText: "" };
  }
  const quoted = quotedTextForRange(primary);
  const anchor = buildAnchor({
    quotedText: quoted,
    paragraphText: primary.paragraphTexts[0] ?? "",
    region: primary.region,
    regionId: primary.regionId,
    paragraphIndex: primary.startParagraphIndex,
    offset: primary.startOffset,
    length: quoted.length,
  });
  if (rest.length > 0) {
    anchor.additionalRanges = rest.map(toAnchorRange);
  }
  return anchor;
}

function quotedTextForRange(r: DocxRange): string {
  // Single-paragraph range: slice once.
  if (r.startParagraphIndex === r.endParagraphIndex) {
    const text = r.paragraphTexts[0] ?? "";
    return text.slice(r.startOffset, r.endOffset);
  }
  // Multi-paragraph: first slice from startOffset, middle paragraphs whole,
  // last slice to endOffset. Joined with `\n` to match Drive's
  // multi-paragraph quotedFileContent format.
  const out: string[] = [];
  const first = r.paragraphTexts[0] ?? "";
  out.push(first.slice(r.startOffset));
  for (let i = 1; i < r.paragraphTexts.length - 1; i++) {
    out.push(r.paragraphTexts[i] ?? "");
  }
  const last = r.paragraphTexts[r.paragraphTexts.length - 1] ?? "";
  out.push(last.slice(0, r.endOffset));
  return out.join("\n");
}

function toAnchorRange(r: DocxRange): AnchorRange {
  return {
    region: r.region,
    regionId: r.regionId || undefined,
    startParagraphIndex: r.startParagraphIndex,
    startOffset: r.startOffset,
    endParagraphIndex: r.endParagraphIndex,
    endOffset: r.endOffset,
  };
}
