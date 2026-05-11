import { tokenProviderForUser } from "../auth/credentials.ts";
import {
  copyFile,
  exportDocx,
  getFile,
  listComments,
  type DriveComment,
  type DriveFile,
} from "../google/drive.ts";
import { parseDocx, type DocxAnnotations } from "../google/docx.ts";

export interface SmokeResult {
  file: DriveFile;
  copy: DriveFile;
  /** Comments + replies from `drive.comments.list` (author identity disambig source). */
  driveComments: DriveComment[];
  /** Parsed `.docx` export — comments with exact anchors + suggestion author/timestamps. */
  annotations: DocxAnnotations;
}

/**
 * End-to-end Drive smoke flow: fetch metadata, copy the doc, list its
 * comments, export it as `.docx` and parse out comments + suggestions.
 * Mirrors the production ingest path (`src/domain/comments.ts`) so the
 * smoke command actually exercises what runs in `pollAllActiveVersions`.
 * No DB writes — purely a connectivity check.
 */
export async function runSmoke(opts: {
  userId: string;
  docId: string;
}): Promise<SmokeResult> {
  const tp = tokenProviderForUser(opts.userId);
  const file = await getFile(tp, opts.docId);
  const copy = await copyFile(tp, opts.docId, {
    name: `[Margin smoke] ${file.name}`,
  });
  const [driveComments, docxBytes] = await Promise.all([
    listComments(tp, opts.docId),
    exportDocx(tp, opts.docId),
  ]);
  const annotations = parseDocx(docxBytes);
  return { file, copy, driveComments, annotations };
}
