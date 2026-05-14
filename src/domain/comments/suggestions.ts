import type { CommentAnchor } from "../../db/schema.ts";
import type { DocxSuggestion } from "../../google/docx.ts";
import { upsertCanonical } from "./upsert.ts";
import { buildAnchor } from "./anchor-build.ts";
import { resolveIdentity, type AuthorIndex } from "./drive-index.ts";
import { hashShort, type IngestResult } from "./types.ts";

export interface SuggestionIngestArgs {
  projectId: string;
  versionId: string;
  suggestions: DocxSuggestion[];
  authorIndex: AuthorIndex;
  result: IngestResult;
}

/**
 * Insert canonical rows for every tracked-change suggestion. Returns the
 * OOXML-id → canonical-id map so the comment-ingest pass can resolve
 * `parent_comment_id` for replies that landed on a suggestion's thread.
 */
export async function ingestSuggestions(
  args: SuggestionIngestArgs,
): Promise<Map<string, string>> {
  const byOoxmlId = new Map<string, string>();
  for (const s of args.suggestions) {
    args.result.fetched++;
    const identity = resolveIdentity(args.authorIndex, s.author);
    const idempotencyKey = suggestionIdempotencyKey(s);
    const insertedBefore = args.result.inserted;
    const id = await upsertCanonical({
      projectId: args.projectId,
      versionId: args.versionId,
      googleCommentId: idempotencyKey,
      kind: s.kind,
      authorDisplayName: s.author || null,
      authorEmail: identity.email,
      authorPhotoHash: identity.photoHash,
      createdIso: s.date,
      body: suggestionBody(s),
      anchor: suggestionAnchor(s),
      parentCommentId: null,
      result: args.result,
    });
    byOoxmlId.set(s.id, id);
    if (args.result.inserted > insertedBefore) args.result.suggestionsInserted++;
  }
  return byOoxmlId;
}

function suggestionBody(s: DocxSuggestion): string {
  return s.kind === "suggestion_insert"
    ? `[suggested insertion] ${s.text}`
    : `[suggested deletion] ${s.text}`;
}

function suggestionAnchor(s: DocxSuggestion): CommentAnchor {
  return buildAnchor({
    quotedText: s.text,
    paragraphText: s.paragraphText,
    region: s.region,
    regionId: s.regionId,
    paragraphIndex: s.paragraphIndex,
    offset: s.offset,
    length: s.length,
  });
}

function suggestionIdempotencyKey(s: DocxSuggestion): string {
  // Suggestion ids rotate across exports; key on content + position so
  // re-ingest of the same revision dedupes. `s.date` is excluded because
  // OOXML rewrites the suggestion timestamp on every export, which would
  // otherwise make a static revision produce a fresh canonical row on every
  // ingest.
  return `mgn:sug:${hashShort(
    `${s.kind} ${s.author} ${s.region} ${s.regionId} ${s.paragraphIndex} ${s.offset} ${s.text}`,
  )}`;
}
