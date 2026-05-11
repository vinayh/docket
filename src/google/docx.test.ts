import { describe, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { parseDocx } from "./docx.ts";

/**
 * Build a `.docx`-shaped zip in memory. We keep these fixtures hand-crafted
 * (not real `.docx` blobs) so each test verifies one specific OOXML shape
 * called out in SPEC §9.8 — exact-anchor coordinates, disjoint multi-range
 * comments, multi-paragraph ranges, suggestion author/timestamp,
 * suggestion-thread reply detection.
 */
function makeDocx(parts: {
  document: string;
  comments?: string;
  footer?: { path: string; xml: string };
  footnotes?: string;
  header?: { path: string; xml: string };
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "word/document.xml": strToU8(parts.document),
  };
  if (parts.comments) files["word/comments.xml"] = strToU8(parts.comments);
  if (parts.footer) files[parts.footer.path] = strToU8(parts.footer.xml);
  if (parts.footnotes) files["word/footnotes.xml"] = strToU8(parts.footnotes);
  if (parts.header) files[parts.header.path] = strToU8(parts.header.xml);
  return zipSync(files);
}

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;

function doc(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${NS}><w:body>${body}</w:body></w:document>`;
}

function comments(xs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:comments ${NS}>${xs}</w:comments>`;
}

describe("parseDocx", () => {
  test("plain comment: single paragraph, single range, body + author + date", () => {
    const bytes = makeDocx({
      document: doc(`
        <w:p>
          <w:r><w:t>Hello </w:t></w:r>
          <w:commentRangeStart w:id="0"/>
          <w:r><w:t>world</w:t></w:r>
          <w:commentRangeEnd w:id="0"/>
          <w:r><w:t>!</w:t></w:r>
        </w:p>`),
      comments: comments(`
        <w:comment w:id="0" w:author="Alice" w:date="2026-01-15T10:00:00Z">
          <w:p><w:r><w:t>looks good</w:t></w:r></w:p>
        </w:comment>`),
    });
    const out = parseDocx(bytes);
    expect(out.comments).toHaveLength(1);
    const c = out.comments[0]!;
    expect(c.id).toBe("0");
    expect(c.author).toBe("Alice");
    expect(c.date).toBe("2026-01-15T10:00:00Z");
    expect(c.body).toBe("looks good");
    expect(c.ranges).toHaveLength(1);
    expect(c.ranges[0]).toMatchObject({
      region: "body",
      regionId: "",
      startParagraphIndex: 0,
      startOffset: 6, // "Hello " = 6 chars
      endParagraphIndex: 0,
      endOffset: 11, // "Hello world" = 11 chars
      paragraphTexts: ["Hello world!"],
    });
    expect(c.overlapsSuggestionId).toBeUndefined();
    expect(out.suggestions).toEqual([]);
  });

  test("multi-paragraph contiguous range spans paragraphs and carries texts in order", () => {
    const bytes = makeDocx({
      document: doc(`
        <w:p>
          <w:r><w:t>Para one start. </w:t></w:r>
          <w:commentRangeStart w:id="0"/>
          <w:r><w:t>tail of one</w:t></w:r>
        </w:p>
        <w:p>
          <w:r><w:t>middle</w:t></w:r>
        </w:p>
        <w:p>
          <w:r><w:t>head of three</w:t></w:r>
          <w:commentRangeEnd w:id="0"/>
          <w:r><w:t> rest.</w:t></w:r>
        </w:p>`),
      comments: comments(`
        <w:comment w:id="0" w:author="Bob" w:date="2026-02-01T09:00:00Z">
          <w:p><w:r><w:t>span comment</w:t></w:r></w:p>
        </w:comment>`),
    });
    const out = parseDocx(bytes);
    const c = out.comments[0]!;
    expect(c.ranges).toHaveLength(1);
    expect(c.ranges[0]).toMatchObject({
      startParagraphIndex: 0,
      startOffset: 16, // "Para one start. " = 16 chars
      endParagraphIndex: 2,
      endOffset: 13, // "head of three"
      paragraphTexts: ["Para one start. tail of one", "middle", "head of three rest."],
    });
  });

  test("disjoint multi-range comment collapses by (author, date, body)", () => {
    const bytes = makeDocx({
      document: doc(`
        <w:p>
          <w:commentRangeStart w:id="0"/>
          <w:r><w:t>alpha</w:t></w:r>
          <w:commentRangeEnd w:id="0"/>
          <w:r><w:t> mid </w:t></w:r>
          <w:commentRangeStart w:id="1"/>
          <w:r><w:t>beta</w:t></w:r>
          <w:commentRangeEnd w:id="1"/>
        </w:p>`),
      comments: comments(`
        <w:comment w:id="0" w:author="Carol" w:date="2026-03-01T12:00:00Z">
          <w:p><w:r><w:t>shared body</w:t></w:r></w:p>
        </w:comment>
        <w:comment w:id="1" w:author="Carol" w:date="2026-03-01T12:00:00Z">
          <w:p><w:r><w:t>shared body</w:t></w:r></w:p>
        </w:comment>`),
    });
    const out = parseDocx(bytes);
    expect(out.comments).toHaveLength(1);
    const c = out.comments[0]!;
    expect(c.author).toBe("Carol");
    expect(c.body).toBe("shared body");
    expect(c.ranges).toHaveLength(2);
    // Order is documented as earliest-range-first; collapse should preserve
    // both spans regardless of which `<w:comment>` row carries the metadata.
    expect(c.ranges[0]!.startOffset).toBe(0);
    expect(c.ranges[1]!.startOffset).toBe(10); // "alpha mid " = 10 chars
  });

  test("suggested insert carries author + timestamp + text + paragraph context", () => {
    const bytes = makeDocx({
      document: doc(`
        <w:p>
          <w:r><w:t>Plain. </w:t></w:r>
          <w:ins w:id="5" w:author="Dee" w:date="2026-04-10T08:30:00Z">
            <w:r><w:t>NEW</w:t></w:r>
          </w:ins>
          <w:r><w:t> tail.</w:t></w:r>
        </w:p>`),
    });
    const out = parseDocx(bytes);
    expect(out.suggestions).toHaveLength(1);
    const s = out.suggestions[0]!;
    expect(s).toMatchObject({
      id: "5",
      kind: "suggestion_insert",
      author: "Dee",
      date: "2026-04-10T08:30:00Z",
      region: "body",
      regionId: "",
      paragraphIndex: 0,
      offset: 7, // "Plain. " = 7 chars
      length: 3,
      text: "NEW",
      paragraphText: "Plain. NEW tail.",
    });
  });

  test("suggested delete pulls text from <w:delText>", () => {
    const bytes = makeDocx({
      document: doc(`
        <w:p>
          <w:r><w:t>Before </w:t></w:r>
          <w:del w:id="9" w:author="Eve" w:date="2026-04-11T08:30:00Z">
            <w:r><w:delText>GONE</w:delText></w:r>
          </w:del>
          <w:r><w:t> after.</w:t></w:r>
        </w:p>`),
    });
    const out = parseDocx(bytes);
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0]).toMatchObject({
      kind: "suggestion_delete",
      author: "Eve",
      text: "GONE",
      length: 4,
      offset: 7,
    });
  });

  test("reply-on-suggestion: comment whose range overlaps a <w:ins> carries that suggestion id", () => {
    const bytes = makeDocx({
      document: doc(`
        <w:p>
          <w:commentRangeStart w:id="0"/>
          <w:r><w:t>before </w:t></w:r>
          <w:ins w:id="42" w:author="Dee" w:date="2026-04-10T08:30:00Z">
            <w:r><w:t>inserted</w:t></w:r>
          </w:ins>
          <w:r><w:t> after</w:t></w:r>
          <w:commentRangeEnd w:id="0"/>
        </w:p>`),
      comments: comments(`
        <w:comment w:id="0" w:author="Reviewer" w:date="2026-04-12T08:30:00Z">
          <w:p><w:r><w:t>reply on the suggestion</w:t></w:r></w:p>
        </w:comment>`),
    });
    const out = parseDocx(bytes);
    expect(out.comments[0]!.overlapsSuggestionId).toBe("42");
  });

  test("comment whose range does NOT overlap a suggestion does not set overlapsSuggestionId", () => {
    const bytes = makeDocx({
      document: doc(`
        <w:p>
          <w:ins w:id="1" w:author="X" w:date="2026-04-01T00:00:00Z">
            <w:r><w:t>ins</w:t></w:r>
          </w:ins>
          <w:r><w:t> separator </w:t></w:r>
          <w:commentRangeStart w:id="0"/>
          <w:r><w:t>plain target</w:t></w:r>
          <w:commentRangeEnd w:id="0"/>
        </w:p>`),
      comments: comments(`
        <w:comment w:id="0" w:author="R" w:date="2026-04-02T00:00:00Z">
          <w:p><w:r><w:t>independent comment</w:t></w:r></w:p>
        </w:comment>`),
    });
    const out = parseDocx(bytes);
    expect(out.comments[0]!.overlapsSuggestionId).toBeUndefined();
  });

  test("comment in a footer is anchored to region=footer with footer file basename as regionId", () => {
    const bytes = makeDocx({
      document: doc(`<w:p><w:r><w:t>body text</w:t></w:r></w:p>`),
      footer: {
        path: "word/footer1.xml",
        xml: `<?xml version="1.0"?>
<w:ftr ${NS}>
  <w:p>
    <w:commentRangeStart w:id="0"/>
    <w:r><w:t>footer phrase</w:t></w:r>
    <w:commentRangeEnd w:id="0"/>
  </w:p>
</w:ftr>`,
      },
      comments: comments(`
        <w:comment w:id="0" w:author="F" w:date="2026-05-01T00:00:00Z">
          <w:p><w:r><w:t>about the footer</w:t></w:r></w:p>
        </w:comment>`),
    });
    const out = parseDocx(bytes);
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]!.ranges[0]).toMatchObject({
      region: "footer",
      regionId: "footer1",
      paragraphTexts: ["footer phrase"],
    });
  });

  test("footnote bodies are walked; built-in separator footnotes (-1, 0) are skipped", () => {
    const bytes = makeDocx({
      document: doc(`<w:p><w:r><w:t>body</w:t></w:r></w:p>`),
      footnotes: `<?xml version="1.0"?>
<w:footnotes ${NS}>
  <w:footnote w:id="-1"><w:p><w:r><w:t>separator</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="0"><w:p><w:r><w:t>continuation</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="1">
    <w:p>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:t>real footnote</w:t></w:r>
      <w:commentRangeEnd w:id="0"/>
    </w:p>
  </w:footnote>
</w:footnotes>`,
      comments: comments(`
        <w:comment w:id="0" w:author="N" w:date="2026-06-01T00:00:00Z">
          <w:p><w:r><w:t>about footnote</w:t></w:r></w:p>
        </w:comment>`),
    });
    const out = parseDocx(bytes);
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]!.ranges[0]).toMatchObject({
      region: "footnote",
      regionId: "1",
      paragraphTexts: ["real footnote"],
    });
  });

  test("doc with no comments.xml part: parses cleanly, returns empty comments", () => {
    const bytes = makeDocx({
      document: doc(`<w:p><w:r><w:t>just text</w:t></w:r></w:p>`),
    });
    const out = parseDocx(bytes);
    expect(out.comments).toEqual([]);
    expect(out.suggestions).toEqual([]);
  });

  test("malformed: missing document.xml entry returns empty annotations instead of throwing", () => {
    const bytes = zipSync({ "irrelevant.xml": strToU8("<x/>") });
    const out = parseDocx(bytes);
    expect(out).toEqual({ comments: [], suggestions: [] });
  });

  test("orphan comment metadata (no commentRangeStart/End) is dropped", () => {
    const bytes = makeDocx({
      document: doc(`<w:p><w:r><w:t>no comment markers anywhere</w:t></w:r></w:p>`),
      comments: comments(`
        <w:comment w:id="0" w:author="X" w:date="2026-07-01T00:00:00Z">
          <w:p><w:r><w:t>dangling</w:t></w:r></w:p>
        </w:comment>`),
    });
    const out = parseDocx(bytes);
    expect(out.comments).toEqual([]);
  });
});
