import { tokenProviderForUser } from "../auth/credentials.ts";
import {
  copyFile,
  getFile,
  listComments,
  type DriveComment,
  type DriveFile,
} from "../google/drive.ts";
import { getDocument } from "../google/docs.ts";
import { extractSuggestions, type SuggestionSpan } from "./suggestions.ts";

export interface SmokeResult {
  file: DriveFile;
  copy: DriveFile;
  comments: DriveComment[];
  suggestions: SuggestionSpan[];
}

/**
 * End-to-end Drive/Docs smoke flow: fetch metadata, copy the doc, list its
 * comments, and walk its tracked-change suggestions. Returns the raw shape
 * for the CLI to render. No DB writes — purely a connectivity check.
 */
export async function runSmoke(opts: {
  userId: string;
  docId: string;
}): Promise<SmokeResult> {
  const tp = tokenProviderForUser(opts.userId);
  const file = await getFile(tp, opts.docId);
  const copy = await copyFile(tp, opts.docId, {
    name: `[Docket smoke] ${file.name}`,
  });
  const comments = await listComments(tp, opts.docId);
  const doc = await getDocument(tp, opts.docId);
  const suggestions = extractSuggestions(doc);
  return { file, copy, comments, suggestions };
}
