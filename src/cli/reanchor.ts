import { projectCommentsOntoVersion } from "../domain/project_comments.ts";
import { die } from "./util.ts";

const USAGE = `\
usage:
  bun docket reanchor <target-version-id>

Re-projects every canonical comment in the version's project onto this version,
updating comment_projection rows. Idempotent.`;

export async function run(args: string[]): Promise<void> {
  const versionId = args[0];
  if (!versionId) die(USAGE);

  const r = await projectCommentsOntoVersion(versionId);
  console.log(
    `✓ projected onto version ${r.versionId}: scanned=${r.scanned} inserted=${r.inserted} updated=${r.updated} unchanged=${r.unchanged}`,
  );
  console.log(
    `  by status: clean=${r.byStatus.clean} fuzzy=${r.byStatus.fuzzy} orphaned=${r.byStatus.orphaned} manually_resolved=${r.byStatus.manually_resolved}`,
  );
}
