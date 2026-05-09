import { describe, expect, test } from "bun:test";
import {
  extractAllParagraphs,
  extractParagraphs,
  extractPlainText,
  op,
  type Document,
} from "./docs.ts";

/**
 * Build a Document fixture from an array of paragraph strings. Mirrors how the
 * Docs API serializes a body: each paragraph gets a trailing newline inside its
 * single text run, and structural startIndex/endIndex flow contiguously.
 */
function docFromParagraphs(paragraphs: string[]): Document {
  let cursor = 1;
  return {
    documentId: "test",
    title: "test",
    body: {
      content: paragraphs.map((text) => {
        const start = cursor;
        const content = text + "\n";
        const end = start + content.length;
        cursor = end;
        return {
          startIndex: start,
          endIndex: end,
          paragraph: {
            elements: [{ startIndex: start, endIndex: end, textRun: { content } }],
          },
        };
      }),
    },
  };
}

describe("op builders", () => {
  test("insertText shapes a batchUpdate request", () => {
    expect(op.insertText("hello", 5)).toEqual({
      insertText: { text: "hello", location: { index: 5 } },
    });
  });

  test("deleteContentRange shapes a batchUpdate request", () => {
    expect(op.deleteContentRange(10, 20)).toEqual({
      deleteContentRange: { range: { startIndex: 10, endIndex: 20 } },
    });
  });

  test("replaceAllText defaults to matchCase=true", () => {
    expect(op.replaceAllText("foo", "bar")).toEqual({
      replaceAllText: {
        containsText: { text: "foo", matchCase: true },
        replaceText: "bar",
      },
    });
  });

  test("replaceAllText honours matchCase override", () => {
    const r = op.replaceAllText("foo", "bar", false) as {
      replaceAllText: { containsText: { matchCase: boolean } };
    };
    expect(r.replaceAllText.containsText.matchCase).toBe(false);
  });
});

describe("extractPlainText", () => {
  test("concatenates every text run, including the trailing newline", () => {
    const doc = docFromParagraphs(["alpha", "bravo"]);
    expect(extractPlainText(doc)).toBe("alpha\nbravo\n");
  });

  test("returns empty string for an empty document", () => {
    expect(extractPlainText({ documentId: "x", title: "x" })).toBe("");
  });

  test("multi-run paragraphs concatenate runs", () => {
    const doc: Document = {
      documentId: "x",
      title: "x",
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 12,
            paragraph: {
              elements: [
                { startIndex: 1, endIndex: 5, textRun: { content: "foo " } },
                { startIndex: 5, endIndex: 11, textRun: { content: "bar\n" } },
              ],
            },
          },
        ],
      },
    };
    expect(extractPlainText(doc)).toBe("foo bar\n");
  });
});

describe("extractParagraphs", () => {
  test("strips the trailing newline and indexes paragraphs from zero", () => {
    const doc = docFromParagraphs(["alpha", "bravo", "charlie"]);
    const out = extractParagraphs(doc);
    expect(out.map((p) => p.text)).toEqual(["alpha", "bravo", "charlie"]);
    expect(out.map((p) => p.paragraphIndex)).toEqual([0, 1, 2]);
  });

  test("preserves doc-coordinate startIndex/endIndex", () => {
    const doc = docFromParagraphs(["alpha"]);
    expect(extractParagraphs(doc)[0]).toMatchObject({
      paragraphIndex: 0,
      text: "alpha",
      startIndex: 1,
      endIndex: 7, // "alpha\n" is 6 chars, end is exclusive
    });
  });

  test("skips structural elements that aren't paragraphs", () => {
    const doc: Document = {
      documentId: "x",
      title: "x",
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 7,
            paragraph: {
              elements: [{ startIndex: 1, endIndex: 7, textRun: { content: "alpha\n" } }],
            },
          },
          { startIndex: 7, endIndex: 50, table: {} },
          { startIndex: 50, endIndex: 51, sectionBreak: {} },
          {
            startIndex: 51,
            endIndex: 57,
            paragraph: {
              elements: [{ startIndex: 51, endIndex: 57, textRun: { content: "bravo\n" } }],
            },
          },
        ],
      },
    };
    const out = extractParagraphs(doc);
    expect(out.map((p) => p.text)).toEqual(["alpha", "bravo"]);
    expect(out.map((p) => p.paragraphIndex)).toEqual([0, 1]);
  });

  test("handles a paragraph without text runs", () => {
    const doc: Document = {
      documentId: "x",
      title: "x",
      body: { content: [{ startIndex: 1, endIndex: 2, paragraph: {} }] },
    };
    expect(extractParagraphs(doc)[0]?.text).toBe("");
  });
});

describe("extractAllParagraphs", () => {
  test("tags body paragraphs as region=body, regionId=''", () => {
    const out = extractAllParagraphs(docFromParagraphs(["alpha"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ region: "body", regionId: "" });
  });

  test("walks headers, footers and footnotes with their ids", () => {
    const para = (text: string) => ({
      startIndex: 1,
      endIndex: text.length + 2,
      paragraph: {
        elements: [{ startIndex: 1, endIndex: text.length + 2, textRun: { content: text + "\n" } }],
      },
    });
    const doc: Document = {
      documentId: "x",
      title: "x",
      body: { content: [para("body-1")] },
      headers: { h1: { headerId: "h1", content: [para("header-1")] } },
      footers: { f1: { footerId: "f1", content: [para("footer-1")] } },
      footnotes: { fn1: { footnoteId: "fn1", content: [para("note-1")] } },
    };
    const out = extractAllParagraphs(doc);
    expect(out).toEqual([
      { paragraphIndex: 0, text: "body-1", startIndex: 1, endIndex: 8, region: "body", regionId: "" },
      { paragraphIndex: 0, text: "header-1", startIndex: 1, endIndex: 10, region: "header", regionId: "h1" },
      { paragraphIndex: 0, text: "footer-1", startIndex: 1, endIndex: 10, region: "footer", regionId: "f1" },
      { paragraphIndex: 0, text: "note-1", startIndex: 1, endIndex: 8, region: "footnote", regionId: "fn1" },
    ]);
  });

  test("returns just body paragraphs when no auxiliary regions are present", () => {
    const out = extractAllParagraphs(docFromParagraphs(["only"]));
    expect(out).toHaveLength(1);
    expect(out[0]?.region).toBe("body");
  });
});
