import { parseGoogleDocId } from "../domain/google-doc-url.ts";
import { runSmoke } from "../domain/smoke.ts";
import { defaultUser, usage } from "./util.ts";

export async function run(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) usage("usage: bun docket smoke <doc-url-or-id>");

  const docId = parseGoogleDocId(arg);
  const u = await defaultUser();
  console.log(`acting as ${u.email} (id=${u.id})`);

  console.log(`\nfetching metadata for ${docId}...`);
  const r = await runSmoke({ userId: u.id, docId });
  console.log(r.file);

  console.log(`\ncopied as ${r.copy.name}`);
  console.log(r.copy);

  console.log(`\n${r.comments.length} comment(s) on the original`);
  for (const c of r.comments) {
    const author = c.author?.displayName ?? "?";
    const quoted = c.quotedFileContent?.value
      ? `"${c.quotedFileContent.value.replace(/\s+/g, " ").slice(0, 60)}"`
      : "(unanchored)";
    console.log(`- ${author} @ ${c.createdTime} on ${quoted}`);
    console.log(`    ${c.content.slice(0, 80)}`);
    for (const reply of c.replies ?? []) {
      const ra = reply.author?.displayName ?? "?";
      const tag = reply.action ? ` [${reply.action}]` : "";
      console.log(`    └─ ${ra}${tag}: ${reply.content.slice(0, 80)}`);
    }
  }

  console.log(`\n${r.suggestions.length} tracked-change suggestion(s)`);
  for (const s of r.suggestions) {
    const tag = s.kind === "suggestion_insert" ? "[insert]" : "[delete]";
    const text = s.text.replace(/\s+/g, " ").slice(0, 60);
    const where = s.region === "body" ? "body" : `${s.region}(${s.regionId})`;
    console.log(`- ${tag} ${where}/para#${s.paragraphIndex}@${s.offset} (id=${s.id}): "${text}"`);
  }
}
