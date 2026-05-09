import { tokenProviderForUser } from "../auth/credentials.ts";
import { authedFetch } from "../google/api.ts";
import { parseGoogleDocId } from "../domain/google-doc-url.ts";
import { defaultUser, usage } from "./util.ts";

/**
 * Dumps the raw, unfiltered responses Google returns for a doc. Use this when
 * you want to know whether some annotation (suggestion reply, resolved comment,
 * etc.) is actually exposed by the public API — if it's not in this output,
 * Docket can't see it.
 */
export async function run(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) usage("usage: bun docket inspect <doc-url-or-id>");

  const docId = parseGoogleDocId(arg);
  const u = await defaultUser();
  const tp = tokenProviderForUser(u.id);

  // 1) Drive comments — fields=* returns the full Comment resource (incl. replies);
  //    without it, Drive v3's partial-response default strips the `comments` array.
  //    includeDeleted=true so we don't miss anything Google has marked deleted.
  const commentsUrl = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/comments`,
  );
  commentsUrl.searchParams.set("fields", "*");
  commentsUrl.searchParams.set("pageSize", "100");
  commentsUrl.searchParams.set("includeDeleted", "true");
  const commentsRes = await authedFetch(tp, commentsUrl);
  const commentsJson = await commentsRes.json();

  console.log("=== drive.comments.list (fields=*, includeDeleted=true) ===");
  console.log(JSON.stringify(commentsJson, null, 2));

  // 2) Docs API document — request inline suggestions explicitly. Docs API v1 returns
  //    the full body by default, so no fields=* needed; specifying it can actually
  //    error on this endpoint.
  const docUrl = new URL(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`);
  docUrl.searchParams.set("suggestionsViewMode", "SUGGESTIONS_INLINE");
  const docRes = await authedFetch(tp, docUrl);
  const doc = (await docRes.json()) as Record<string, unknown>;

  // Include headers + footers + footnotes + documentStyle so footer/header suggestions
  // are visible if Google does surface them. Full body kept too — these can be large.
  const trimmed = {
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
  console.log("\n=== documents.get (SUGGESTIONS_INLINE) ===");
  console.log(JSON.stringify(trimmed, null, 2));
}
