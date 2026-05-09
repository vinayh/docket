import { parseArgs } from "node:util";
import { projectCommentsOntoVersion } from "../domain/project_comments.ts";
import { usage } from "./util.ts";

const USAGE = `\
usage:
  bun docket reanchor <target-version-id> [--quiet]

Re-projects every canonical comment in the version's project onto this version,
updating comment_projection rows. Idempotent. Prints per-comment alignment by
default; pass --quiet for the summary only.`;

const SNIPPET = 60;

function clip(s: string, n = SNIPPET): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

export async function run(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { quiet: { type: "boolean" } },
    allowPositionals: true,
  });
  const versionId = positionals[0];
  if (!versionId) usage(USAGE);

  const r = await projectCommentsOntoVersion(versionId);

  if (!values.quiet && r.details.length > 0) {
    for (const d of r.details) {
      const cc = d.canonicalComment;
      const res = d.result;
      const author = cc.originUserDisplayName ?? cc.originUserEmail ?? "—";
      const sourceQuoted = cc.anchor.quotedText
        ? `"${clip(cc.anchor.quotedText, 40)}"`
        : "(unanchored)";
      console.log(
        `${cc.id.slice(0, 8)}  ${res.status.padEnd(8)} conf=${String(res.confidence).padStart(3)}  ${cc.kind.padEnd(18)} ${author}`,
      );
      console.log(`  src: ${sourceQuoted}`);
      console.log(`  body: ${clip(cc.body, 80)}`);
      if (res.paragraph && res.matchedText !== undefined) {
        const p = res.paragraph;
        const offset = res.anchor.structuralPosition?.offset ?? 0;
        const matchEnd = offset + res.matchedText.length;
        const before = p.text.slice(Math.max(0, offset - 24), offset);
        const matched = p.text.slice(offset, matchEnd);
        const after = p.text.slice(matchEnd, matchEnd + 24);
        console.log(
          `  → para[${p.paragraphIndex}] @${offset}: …${clip(before, 24)}«${clip(matched, 40)}»${clip(after, 24)}…`,
        );
      } else {
        console.log(`  → no aligned paragraph (orphaned)`);
      }
    }
    console.log("");
  }

  console.log(
    `✓ projected onto version ${r.versionId}: scanned=${r.scanned} inserted=${r.inserted} updated=${r.updated} unchanged=${r.unchanged}`,
  );
  console.log(
    `  by status: clean=${r.byStatus.clean} fuzzy=${r.byStatus.fuzzy} orphaned=${r.byStatus.orphaned} manually_resolved=${r.byStatus.manually_resolved}`,
  );
}
