import { parseArgs } from "node:util";
import { createVersion, listVersions } from "../domain/version.ts";
import { die, resolveUser } from "./util.ts";

const USAGE = `\
usage:
  bun docket version create <project-id> [--label <label>] [--user <email>]
  bun docket version list <project-id>`;

export async function run(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub) die(USAGE);

  if (sub === "create") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        label: { type: "string" },
        user: { type: "string" },
      },
      allowPositionals: true,
    });
    const projectId = positionals[0];
    if (!projectId) die(USAGE);

    const u = await resolveUser(values.user);
    const v = await createVersion({
      projectId,
      createdByUserId: u.id,
      ...(values.label !== undefined ? { label: values.label } : {}),
    });
    console.log(`✓ created version ${v.label} (id=${v.id})`);
    console.log(`  google_doc_id: ${v.googleDocId}`);
    console.log(`  parent_version: ${v.parentVersionId ?? "(none)"}`);
    console.log(`  hash: ${v.snapshotContentHash}`);
    return;
  }

  if (sub === "list") {
    const projectId = rest[0];
    if (!projectId) die(USAGE);
    const versions = await listVersions(projectId);
    if (versions.length === 0) {
      console.log("no versions.");
      return;
    }
    for (const v of versions) {
      const parent = v.parentVersionId ? `parent=${v.parentVersionId.slice(0, 8)}` : "root";
      console.log(
        `${v.label.padEnd(8)} ${v.id}  ${parent}  doc=${v.googleDocId}  ${v.status}  ${v.createdAt.toISOString()}`,
      );
    }
    return;
  }

  die(USAGE);
}
