import { runV2Check } from "../domain/v2-check.ts";
import { defaultUser } from "./util.ts";

export async function run(_args: string[]): Promise<void> {
  const u = await defaultUser();
  console.log(`acting as ${u.email} (id=${u.id})`);
  console.log(
    "\nuploading a probe .docx to Drive (will be converted to a Google Doc)...",
  );
  const r = await runV2Check({ userId: u.id });
  console.log(`\nuploaded: ${r.uploadedFileName} (id=${r.uploadedFileId})`);
  console.log(
    `https://docs.google.com/document/d/${encodeURIComponent(r.uploadedFileId)}/edit`,
  );

  console.log("\nINPUT:");
  console.log(
    `  ${r.input.comments.length} comments / ${r.input.suggestions.length} suggestions`,
  );

  console.log("\nOUTPUT (re-exported from the converted Doc):");
  console.log(
    `  ${r.output.comments.length} comments / ${r.output.suggestions.length} suggestions`,
  );
  for (const c of r.output.comments) {
    const ranges = c.ranges
      .map(
        (rng) =>
          `${rng.region}/para#${rng.startParagraphIndex}@${rng.startOffset}-${rng.endParagraphIndex}@${rng.endOffset}`,
      )
      .join(" | ");
    console.log(
      `  - "${c.body.slice(0, 60)}" by ${c.author} @ ${c.date} :: ${ranges}`,
    );
  }
  for (const s of r.output.suggestions) {
    console.log(
      `  - [${s.kind}] "${s.text.slice(0, 60)}" by ${s.author} @ ${s.date} :: para#${s.paragraphIndex}@${s.offset}`,
    );
  }

  console.log("\nOBSERVATIONS:");
  console.log(`  (a) anchors landed:       ${r.observations.a_anchorsLanded}`);
  console.log(`  (b) author preserved:     ${r.observations.b_authorPreserved}`);
  console.log(`  (c) timestamp preserved:  ${r.observations.c_timestampPreserved}`);
  console.log(`  (d) disjoint multi-range: ${r.observations.d_disjointMultiRange}`);
  console.log(`  (e) suggestions:          ${r.observations.e_suggestionsRoundTrip}`);

  console.log(
    "\nRecord these findings in docs/spec.md §9.9 (or §12 Phase 6 V2).",
  );
}
