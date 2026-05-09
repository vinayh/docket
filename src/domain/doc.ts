import { tokenProviderForUser } from "../auth/credentials.ts";
import { batchUpdate, createDocument, op, type Document } from "../google/docs.ts";

const SEED_PARAGRAPHS: readonly string[] = [
  "Introduction. This is a Docket test document.",
  "The reanchoring engine is authoritative — canonical anchors live in Docket's own schema.",
  "Highlight any sentence in this document and add a comment to test ingestion.",
  "Final paragraph. You can edit this freely; Docket will pick up changes via comments ingest.",
];

export interface CreateDocResult {
  doc: Document;
  seededParagraphs: number;
}

/**
 * Create a fresh Google Doc owned by `userId`. When `seed` is true, populate
 * it with a small fixed set of test paragraphs — useful for exercising the
 * comments / suggestions ingest path against a known shape.
 */
export async function createTestDocument(opts: {
  userId: string;
  title: string;
  seed?: boolean;
}): Promise<CreateDocResult> {
  const tp = tokenProviderForUser(opts.userId);
  const doc = await createDocument(tp, { title: opts.title });

  if (!opts.seed) return { doc, seededParagraphs: 0 };

  // Each request inserts at index 1 and pushes prior insertions down, so
  // iterating in reverse preserves the source array order in the doc.
  const requests = [...SEED_PARAGRAPHS]
    .reverse()
    .map((p) => op.insertText(p + "\n", 1));
  await batchUpdate(tp, doc.documentId, requests);
  return { doc, seededParagraphs: SEED_PARAGRAPHS.length };
}
