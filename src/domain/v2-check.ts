import { strToU8, zipSync } from "fflate";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { exportDocx, uploadFileMultipart } from "../google/drive.ts";
import {
  parseDocx,
  type DocxComment,
  type DocxSuggestion,
} from "../google/docx.ts";

/**
 * Empirical validation: when we upload a `.docx` to Drive with "Convert to
 * Docs editor format" enabled, do anchored comments survive? Disjoint multi-
 * range comments? Original `w:author` / `w:date` metadata? Tracked-change
 * suggestions as suggesting-mode edits? Outcome shapes Phase 6 architecture
 * (see spec.md §12 Phase 6 V2). This is a one-shot smoke; results land in
 * docs/spec.md §9.9 once the operator runs it.
 *
 * What it does:
 *   1. Builds a small `.docx` with three known anchors (start-of-paragraph,
 *      mid-paragraph, disjoint multi-range) and one suggested insertion +
 *      one suggested deletion.
 *   2. Uploads to Drive with conversion → Google Doc.
 *   3. Re-exports the resulting Doc as `.docx` and reparses it.
 *   4. Returns a structured diff of original vs. round-tripped annotations.
 */

const KNOWN_AUTHOR = "Margin V2 Probe";
const KNOWN_DATE = "2026-05-13T12:00:00Z";
const DOC_TITLE_PREFIX = "[margin v2-check]";

export interface V2CheckReport {
  uploadedFileId: string;
  uploadedFileName: string;
  // What we put in.
  input: {
    comments: { id: string; author: string; date: string; body: string }[];
    suggestions: { kind: "insert" | "delete"; author: string; date: string; text: string }[];
  };
  // What we got back from `files.export` on the converted Doc.
  output: {
    comments: DocxComment[];
    suggestions: DocxSuggestion[];
  };
  observations: {
    // Per spec §12 V2 questions:
    a_anchorsLanded: string;
    b_authorPreserved: string;
    c_timestampPreserved: string;
    d_disjointMultiRange: string;
    e_suggestionsRoundTrip: string;
  };
}

export async function runV2Check(opts: { userId: string }): Promise<V2CheckReport> {
  const tp = tokenProviderForUser(opts.userId);

  // 1. Build the probe doc.
  const inputBytes = buildProbeDocx();
  const inputParsed = parseDocx(inputBytes);

  // 2. Upload + convert.
  const file = await uploadFileMultipart(tp, {
    name: `${DOC_TITLE_PREFIX} ${new Date().toISOString()}`,
    bytes: inputBytes,
    sourceMimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    targetMimeType: "application/vnd.google-apps.document",
  });

  // 3. Re-export the converted Doc as docx and parse.
  const outputBytes = await exportDocx(tp, file.id);
  const outputParsed = parseDocx(outputBytes);

  // 4. Compute observations.
  const observations = compareAnnotations(inputParsed, outputParsed);

  return {
    uploadedFileId: file.id,
    uploadedFileName: file.name,
    input: {
      comments: inputParsed.comments.map((c) => ({
        id: c.id,
        author: c.author ?? "",
        date: c.date ?? "",
        body: c.body,
      })),
      suggestions: inputParsed.suggestions.map((s) => ({
        kind: s.kind === "suggestion_insert" ? "insert" : "delete",
        author: s.author ?? "",
        date: s.date ?? "",
        text: s.text,
      })),
    },
    output: {
      comments: outputParsed.comments,
      suggestions: outputParsed.suggestions,
    },
    observations,
  };
}

function compareAnnotations(
  input: ReturnType<typeof parseDocx>,
  output: ReturnType<typeof parseDocx>,
): V2CheckReport["observations"] {
  const inputCommentCount = input.comments.length;
  const outputCommentCount = output.comments.length;

  const a_anchorsLanded =
    inputCommentCount === outputCommentCount
      ? `all ${inputCommentCount} comments round-tripped — see ranges below for exact positions`
      : `mismatch: ${inputCommentCount} in / ${outputCommentCount} out — see output.comments[] for what survived`;

  const authorMatches = output.comments.every((c) => c.author === KNOWN_AUTHOR);
  const b_authorPreserved = output.comments.length === 0
    ? "n/a (no comments survived)"
    : authorMatches
      ? `original w:author "${KNOWN_AUTHOR}" preserved on every round-tripped comment`
      : `w:author rewritten: original "${KNOWN_AUTHOR}", observed [${[
          ...new Set(output.comments.map((c) => c.author ?? "")),
        ].join(", ")}]`;

  const datesMatch = output.comments.every((c) => c.date === KNOWN_DATE);
  const c_timestampPreserved = output.comments.length === 0
    ? "n/a (no comments survived)"
    : datesMatch
      ? `original w:date "${KNOWN_DATE}" preserved`
      : `w:date rewritten on upload: original "${KNOWN_DATE}", observed [${[
          ...new Set(output.comments.map((c) => c.date ?? "")),
        ].join(", ")}]`;

  // Disjoint multi-range: one comment with two ranges in the input.
  const inputDisjoint = input.comments.find((c) => c.ranges.length > 1);
  const outputDisjointMatches = inputDisjoint
    ? output.comments.filter((c) => c.body === inputDisjoint.body)
    : [];
  const d_disjointMultiRange = !inputDisjoint
    ? "n/a (no disjoint input)"
    : outputDisjointMatches.length === 0
      ? "lost: disjoint comment body not found in output"
      : outputDisjointMatches.length === 1 &&
          outputDisjointMatches[0]!.ranges.length === inputDisjoint.ranges.length
        ? `preserved: single comment with ${outputDisjointMatches[0]!.ranges.length} ranges`
        : `fragmented: input was 1 comment / ${inputDisjoint.ranges.length} ranges, output is ${outputDisjointMatches.length} comments / ${outputDisjointMatches.map((c) => c.ranges.length).join("+")} ranges`;

  const inSug = input.suggestions.length;
  const outSug = output.suggestions.length;
  const e_suggestionsRoundTrip = inSug === 0
    ? "n/a (no suggestions in input)"
    : outSug === 0
      ? `lost: ${inSug} suggestions in input, 0 in output`
      : outSug === inSug
        ? `preserved: ${outSug} suggestions, kinds=[${output.suggestions.map((s) => s.kind).join(", ")}]`
        : `partial: ${inSug} in / ${outSug} out (kinds=[${output.suggestions.map((s) => s.kind).join(", ")}])`;

  return {
    a_anchorsLanded,
    b_authorPreserved,
    c_timestampPreserved,
    d_disjointMultiRange,
    e_suggestionsRoundTrip,
  };
}

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;

/**
 * Build a `.docx` with three known anchors + two suggestions. Plain-OOXML —
 * skips most of the `[Content_Types].xml` ceremony Word adds because Drive's
 * converter is lenient about the part graph.
 */
export function buildProbeDocx(): Uint8Array {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${NS}>
  <w:body>
    <w:p>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:t>Probe paragraph one</w:t></w:r>
      <w:commentRangeEnd w:id="0"/>
      <w:r><w:t>. Suffix.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Probe </w:t></w:r>
      <w:commentRangeStart w:id="1"/>
      <w:r><w:t>middle</w:t></w:r>
      <w:commentRangeEnd w:id="1"/>
      <w:r><w:t> two</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Probe </w:t></w:r>
      <w:commentRangeStart w:id="2"/>
      <w:r><w:t>three-a</w:t></w:r>
      <w:commentRangeEnd w:id="2"/>
      <w:r><w:t> bridge </w:t></w:r>
      <w:commentRangeStart w:id="3"/>
      <w:r><w:t>three-b</w:t></w:r>
      <w:commentRangeEnd w:id="3"/>
      <w:r><w:t>.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Pre-suggestion. </w:t></w:r>
      <w:ins w:id="100" w:author="${KNOWN_AUTHOR}" w:date="${KNOWN_DATE}">
        <w:r><w:t>inserted text</w:t></w:r>
      </w:ins>
      <w:r><w:t> middle. </w:t></w:r>
      <w:del w:id="101" w:author="${KNOWN_AUTHOR}" w:date="${KNOWN_DATE}">
        <w:r><w:delText>deleted text</w:delText></w:r>
      </w:del>
      <w:r><w:t> tail.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;

  const commentsXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:comments ${NS}>
  <w:comment w:id="0" w:author="${KNOWN_AUTHOR}" w:date="${KNOWN_DATE}">
    <w:p><w:r><w:t>start-of-paragraph anchor probe</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="1" w:author="${KNOWN_AUTHOR}" w:date="${KNOWN_DATE}">
    <w:p><w:r><w:t>mid-paragraph anchor probe</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="2" w:author="${KNOWN_AUTHOR}" w:date="${KNOWN_DATE}">
    <w:p><w:r><w:t>disjoint multi-range probe</w:t></w:r></w:p>
  </w:comment>
  <w:comment w:id="3" w:author="${KNOWN_AUTHOR}" w:date="${KNOWN_DATE}">
    <w:p><w:r><w:t>disjoint multi-range probe</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;

  // Minimal [Content_Types].xml + relationships so Drive's converter accepts the bundle.
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypesXml),
    "_rels/.rels": strToU8(rootRelsXml),
    "word/_rels/document.xml.rels": strToU8(docRelsXml),
    "word/document.xml": strToU8(documentXml),
    "word/comments.xml": strToU8(commentsXml),
  });
}
