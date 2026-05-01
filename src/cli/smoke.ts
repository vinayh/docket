import { tokenProviderForUser } from "../auth/credentials.ts";
import { copyFile, getFile, listComments } from "../google/drive.ts";
import { parseGoogleDocId } from "../domain/google-doc-url.ts";
import { defaultUser, die } from "./util.ts";

export async function run(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) die("usage: bun docket smoke <doc-url-or-id>");

  const docId = parseGoogleDocId(arg);
  const u = await defaultUser();
  console.log(`acting as ${u.email} (id=${u.id})`);

  const tp = tokenProviderForUser(u.id);

  console.log(`\nfetching metadata for ${docId}...`);
  const file = await getFile(tp, docId);
  console.log(file);

  console.log(`\ncopying ${file.name}...`);
  const copy = await copyFile(tp, docId, { name: `[docket smoke] ${file.name}` });
  console.log(copy);

  console.log(`\nlisting comments on the original...`);
  const comments = await listComments(tp, docId);
  console.log(`${comments.length} comment(s)`);
  for (const c of comments) {
    console.log(
      `- ${c.author?.displayName ?? "?"} @ ${c.createdTime}: ${c.content.slice(0, 60)}`,
    );
  }
}
