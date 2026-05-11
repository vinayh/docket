import { tokenProviderForUser } from "../auth/credentials.ts";
import { authedFetch } from "../google/api.ts";

export interface InspectResult {
  /** Raw `drive.comments.list` response with `fields=*` and `includeDeleted=true`. */
  comments: unknown;
  /**
   * Trimmed `documents.get` response. Body is preserved (essential for
   * verifying suggestion shapes), but private documentStyle internals etc.
   * stay attached so a header/footer suggestion is visible if Google
   * surfaces it.
   */
  document: Record<string, unknown>;
}

/**
 * Dump the raw, unfiltered Drive + Docs responses for a doc. Use this when
 * you need to confirm whether some annotation (suggestion reply, resolved
 * comment, etc.) is actually exposed by the public API — if it's not in
 * this output, Margin can't see it.
 *
 * Lives in the domain layer so the diagnostic isn't reimplemented per
 * surface; the CLI wrapper just renders the result.
 */
export async function inspectDoc(opts: {
  userId: string;
  docId: string;
}): Promise<InspectResult> {
  const tp = tokenProviderForUser(opts.userId);

  // Drive comments — fields=* returns the full Comment resource (incl.
  // replies); without it, Drive v3's partial-response default strips the
  // `comments` array. includeDeleted=true so we don't miss anything Google
  // has marked deleted.
  const commentsUrl = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(opts.docId)}/comments`,
  );
  commentsUrl.searchParams.set("fields", "*");
  commentsUrl.searchParams.set("pageSize", "100");
  commentsUrl.searchParams.set("includeDeleted", "true");
  const commentsRes = await authedFetch(tp, commentsUrl);
  const comments = await commentsRes.json();

  // Docs API document — request inline suggestions explicitly. Docs API v1
  // returns the full body by default, so no fields=* needed; specifying it
  // can actually error on this endpoint.
  const docUrl = new URL(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(opts.docId)}`,
  );
  docUrl.searchParams.set("suggestionsViewMode", "SUGGESTIONS_INLINE");
  const docRes = await authedFetch(tp, docUrl);
  const doc = (await docRes.json()) as Record<string, unknown>;

  // Trim to the fields most diagnostically useful — header/footer/footnote
  // attached so non-body suggestions are visible if Google does surface them.
  const document = {
    documentId: doc.documentId,
    title: doc.title,
    revisionId: doc.revisionId,
    suggestionsViewMode: doc.suggestionsViewMode,
    documentStyle: doc.documentStyle,
    namedRanges: doc.namedRanges,
    headers: doc.headers,
    footers: doc.footers,
    footnotes: doc.footnotes,
    body: doc.body,
  };

  return { comments, document };
}
