import { parseArgs } from "node:util";
import { createTestDocument } from "../domain/doc.ts";
import { googleDocUrl } from "../domain/google-doc-url.ts";
import { dispatchSubcommands, resolveUser } from "./util.ts";

const USAGE = `\
usage:
  bun docket doc create [--title <title>] [--seed] [--user <email>]`;

export const run = (args: string[]) =>
  dispatchSubcommands(args, USAGE, {
    create: async (rest) => {
      const { values } = parseArgs({
        args: rest,
        options: {
          title: { type: "string" },
          seed: { type: "boolean" },
          user: { type: "string" },
        },
      });

      const u = await resolveUser(values.user);
      const title =
        values.title ?? `Docket test doc ${new Date().toISOString().slice(0, 10)}`;
      const r = await createTestDocument({
        userId: u.id,
        title,
        seed: values.seed === true,
      });

      console.log(`✓ created doc ${r.doc.documentId}`);
      console.log(`  title: ${r.doc.title}`);
      console.log(`  url:   ${googleDocUrl(r.doc.documentId)}`);
      console.log(`  owner: ${u.email}`);
      if (r.seededParagraphs > 0) {
        console.log(`  seeded with ${r.seededParagraphs} paragraphs`);
      }
    },
  });
