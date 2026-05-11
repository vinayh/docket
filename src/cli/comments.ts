import { ingestVersionComments, listCommentsForProject } from "../domain/comments.ts";
import { usage, dispatchSubcommands } from "./util.ts";

const USAGE = `\
usage:
  bun margin comments ingest <version-id>
  bun margin comments list <project-id>`;

export const run = (args: string[]) =>
  dispatchSubcommands(args, USAGE, {
    ingest: async ([versionId]) => {
      if (!versionId) usage(USAGE);
      const r = await ingestVersionComments(versionId);
      console.log(
        `✓ ingested version ${r.versionId}: fetched=${r.fetched} inserted=${r.inserted} (suggestions=${r.suggestionsInserted}) already_present=${r.alreadyPresent} skipped_orphan_metadata=${r.skippedOrphanMetadata}`,
      );
    },

    list: async ([projectId]) => {
      if (!projectId) usage(USAGE);
      const comments = await listCommentsForProject(projectId);
      if (comments.length === 0) {
        console.log("no canonical comments.");
        return;
      }
      for (const c of comments) {
        const author = c.originUserDisplayName ?? c.originUserEmail ?? "—";
        const quoted = c.anchor.quotedText
          ? `"${c.anchor.quotedText.slice(0, 40)}"`
          : "(unanchored)";
        const parent = c.parentCommentId ? ` reply→${c.parentCommentId.slice(0, 8)}` : "";
        console.log(
          `${c.id}  ${c.kind.padEnd(18)}  ${c.status.padEnd(10)}  ${author}  ${quoted}${parent}\n  ${c.body.slice(0, 80)}`,
        );
      }
    },
  });
