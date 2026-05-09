import { tokenProviderForUser } from "../auth/credentials.ts";
import { copyFile, getFile, listComments } from "../google/drive.ts";
import { getDocument } from "../google/docs.ts";
import { parseGoogleDocId } from "../domain/google-doc-url.ts";
import { extractSuggestions } from "../domain/suggestions.ts";
import { defaultUser, usage } from "./util.ts";

export async function run(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) usage("usage: bun docket smoke <doc-url-or-id>");

  const docId = parseGoogleDocId(arg);
  const u = await defaultUser();
  console.log(`acting as ${u.email} (id=${u.id})`);

  const tp = tokenProviderForUser(u.id);

  console.log(`\nfetching metadata for ${docId}...`);
  const file = await getFile(tp, docId);
  console.log(file);

  console.log(`\ncopying ${file.name}...`);
  const copy = await copyFile(tp, docId, { name: `[Docket smoke] ${file.name}` });
  console.log(copy);

  console.log(`\nlisting comments on the original...`);
  const comments = await listComments(tp, docId);
  console.log(`${comments.length} comment(s)`);
  for (const c of comments) {
    const author = c.author?.displayName ?? "?";
    const quoted = c.quotedFileContent?.value
      ? `"${c.quotedFileContent.value.replace(/\s+/g, " ").slice(0, 60)}"`
      : "(unanchored)";
    console.log(`- ${author} @ ${c.createdTime} on ${quoted}`);
    console.log(`    ${c.content.slice(0, 80)}`);
    for (const r of c.replies ?? []) {
      const ra = r.author?.displayName ?? "?";
      const tag = r.action ? ` [${r.action}]` : "";
      console.log(`    └─ ${ra}${tag}: ${r.content.slice(0, 80)}`);
    }
  }

  console.log(`\nlisting tracked-change suggestions on the original...`);
  const doc = await getDocument(tp, docId);
  const suggestions = extractSuggestions(doc);
  console.log(`${suggestions.length} suggestion(s)`);
  for (const s of suggestions) {
    const tag = s.kind === "suggestion_insert" ? "[insert]" : "[delete]";
    const text = s.text.replace(/\s+/g, " ").slice(0, 60);
    const where = s.region === "body" ? "body" : `${s.region}(${s.regionId})`;
    console.log(`- ${tag} ${where}/para#${s.paragraphIndex}@${s.offset} (id=${s.id}): "${text}"`);
  }
}
