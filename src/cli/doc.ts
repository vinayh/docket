import { parseArgs } from "node:util";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { batchUpdate, createDocument, op } from "../google/docs.ts";
import { googleDocUrl } from "../domain/google-doc-url.ts";
import { die, resolveUser } from "./util.ts";

const USAGE = `\
usage:
  bun docket doc create [--title <title>] [--seed] [--user <email>]`;

const SEED_PARAGRAPHS = [
  "Introduction. This is a Docket test document.",
  "The reanchoring engine is authoritative — canonical anchors live in Docket's own schema.",
  "Highlight any sentence in this document and add a comment to test ingestion.",
  "Final paragraph. You can edit this freely; Docket will pick up changes via comments ingest.",
];

export async function run(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "create") die(USAGE);

  const { values } = parseArgs({
    args: rest,
    options: {
      title: { type: "string" },
      seed: { type: "boolean" },
      user: { type: "string" },
    },
  });

  const u = await resolveUser(values.user);
  const tp = tokenProviderForUser(u.id);

  const title = values.title ?? `Docket test doc ${new Date().toISOString().slice(0, 10)}`;
  const doc = await createDocument(tp, { title });

  if (values.seed) {
    // Insert paragraphs at index 1 (start of body). Each request inserts at index 1
    // and pushes the previous insertions down, so iterate in reverse to preserve order.
    const requests = [...SEED_PARAGRAPHS]
      .reverse()
      .map((p) => op.insertText(p + "\n", 1));
    await batchUpdate(tp, doc.documentId, requests);
  }

  console.log(`✓ created doc ${doc.documentId}`);
  console.log(`  title: ${doc.title}`);
  console.log(`  url:   ${googleDocUrl(doc.documentId)}`);
  console.log(`  owner: ${u.email}`);
  if (values.seed) console.log(`  seeded with ${SEED_PARAGRAPHS.length} paragraphs`);
}
