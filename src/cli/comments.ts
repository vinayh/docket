import { ingestVersionComments, listCommentsForProject } from "../domain/comments.ts";
import { die } from "./util.ts";

const USAGE = `\
usage:
  bun docket comments ingest <version-id>
  bun docket comments list <project-id>`;

export async function run(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub) die(USAGE);

  if (sub === "ingest") {
    const versionId = rest[0];
    if (!versionId) die(USAGE);
    const r = await ingestVersionComments(versionId);
    console.log(
      `✓ ingested version ${r.versionId}: fetched=${r.fetched} inserted=${r.inserted} (suggestions=${r.suggestionsInserted}) already_present=${r.alreadyPresent} skipped=${r.skipped}`,
    );
    return;
  }

  if (sub === "list") {
    const projectId = rest[0];
    if (!projectId) die(USAGE);
    const comments = await listCommentsForProject(projectId);
    if (comments.length === 0) {
      console.log("no canonical comments.");
      return;
    }
    for (const c of comments) {
      const author = c.originUserDisplayName ?? c.originUserEmail ?? "—";
      const quoted = c.anchor.quotedText ? `"${c.anchor.quotedText.slice(0, 40)}"` : "(unanchored)";
      const parent = c.parentCommentId ? ` reply→${c.parentCommentId.slice(0, 8)}` : "";
      console.log(
        `${c.id}  ${c.kind.padEnd(18)}  ${c.status.padEnd(10)}  ${author}  ${quoted}${parent}\n  ${c.body.slice(0, 80)}`,
      );
    }
    return;
  }

  die(USAGE);
}
