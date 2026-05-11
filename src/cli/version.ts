import { parseArgs } from "node:util";
import { createVersion, listVersions } from "../domain/version.ts";
import { googleDocUrl } from "../domain/google-doc-url.ts";
import { usage, dispatchSubcommands, resolveUser } from "./util.ts";

const USAGE = `\
usage:
  bun margin version create <project-id> [--label <label>] [--user <email>]
  bun margin version list <project-id>`;

export const run = (args: string[]) =>
  dispatchSubcommands(args, USAGE, {
    create: async (rest) => {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          label: { type: "string" },
          user: { type: "string" },
        },
        allowPositionals: true,
      });
      const projectId = positionals[0];
      if (!projectId) usage(USAGE);

      const u = await resolveUser(values.user);
      const v = await createVersion({
        projectId,
        createdByUserId: u.id,
        ...(values.label !== undefined ? { label: values.label } : {}),
      });
      console.log(`✓ created version ${v.label} (id=${v.id})`);
      console.log(`  google_doc_id: ${v.googleDocId}`);
      console.log(`  url: ${googleDocUrl(v.googleDocId)}`);
      console.log(`  parent_version: ${v.parentVersionId ?? "(none)"}`);
      console.log(`  hash: ${v.snapshotContentHash}`);
    },

    list: async ([projectId]) => {
      if (!projectId) usage(USAGE);
      const versions = await listVersions(projectId);
      if (versions.length === 0) {
        console.log("no versions.");
        return;
      }
      for (const v of versions) {
        const parent = v.parentVersionId
          ? `parent=${v.parentVersionId.slice(0, 8)}`
          : "root";
        console.log(
          `${v.label.padEnd(8)} ${v.id}  ${parent}  doc=${v.googleDocId}  ${v.status}  ${v.createdAt.toISOString()}`,
        );
        console.log(`  ${googleDocUrl(v.googleDocId)}`);
      }
    },
  });
