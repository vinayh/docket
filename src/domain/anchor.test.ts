import { describe, expect, test } from "bun:test";
import { anchorAt, buildAnchor, orphanAnchor, paragraphHash } from "./anchor.ts";
import type { Document, RegionParagraphText, StructuralElement } from "../google/docs.ts";

function paragraphsToContent(paragraphs: string[], startCursor = 1): StructuralElement[] {
  let cursor = startCursor;
  return paragraphs.map((text) => {
    const start = cursor;
    const content = text + "\n";
    const end = start + content.length;
    cursor = end;
    return {
      startIndex: start,
      endIndex: end,
      paragraph: {
        elements: [
          {
            startIndex: start,
            endIndex: end,
            textRun: { content },
          },
        ],
      },
    };
  });
}

function docFromParagraphs(paragraphs: string[]): Document {
  return {
    documentId: "test",
    title: "test",
    body: { content: paragraphsToContent(paragraphs) },
  };
}

/**
 * Build a doc with body + at most one header / footer / footnote, each with
 * its own paragraph list. Use to exercise anchor builders' region awareness.
 */
function multiRegionDoc(opts: {
  body?: string[];
  header?: { id: string; paragraphs: string[] };
  footer?: { id: string; paragraphs: string[] };
  footnote?: { id: string; paragraphs: string[] };
}): Document {
  const doc: Document = {
    documentId: "test",
    title: "test",
    body: { content: paragraphsToContent(opts.body ?? []) },
  };
  if (opts.header) {
    doc.headers = {
      [opts.header.id]: {
        headerId: opts.header.id,
        content: paragraphsToContent(opts.header.paragraphs),
      },
    };
  }
  if (opts.footer) {
    doc.footers = {
      [opts.footer.id]: {
        footerId: opts.footer.id,
        content: paragraphsToContent(opts.footer.paragraphs),
      },
    };
  }
  if (opts.footnote) {
    doc.footnotes = {
      [opts.footnote.id]: {
        footnoteId: opts.footnote.id,
        content: paragraphsToContent(opts.footnote.paragraphs),
      },
    };
  }
  return doc;
}

describe("paragraphHash", () => {
  test("is stable for the same text", () => {
    expect(paragraphHash("hello world")).toBe(paragraphHash("hello world"));
  });

  test("differs for different text", () => {
    expect(paragraphHash("hello")).not.toBe(paragraphHash("hello world"));
  });
});

describe("buildAnchor", () => {
  const doc = docFromParagraphs([
    "Introduction to Margin.",
    "The reanchoring engine is authoritative — canonical anchors live in Margin's own schema.",
    "Final paragraph with no special content.",
  ]);

  test("returns null for empty input", () => {
    expect(buildAnchor(doc, "")).toBeNull();
  });

  test("returns null when the snippet is absent", () => {
    expect(buildAnchor(doc, "no such thing")).toBeNull();
  });

  test("locates the snippet in the correct paragraph", () => {
    const match = buildAnchor(doc, "reanchoring engine");
    expect(match).not.toBeNull();
    expect(match!.paragraph.paragraphIndex).toBe(1);
    expect(match!.anchor.structuralPosition).toEqual({
      paragraphIndex: 1,
      offset: 4,
    });
  });

  test("captures surrounding context", () => {
    const match = buildAnchor(doc, "reanchoring engine")!;
    expect(match.anchor.contextBefore).toBe("The ");
    expect(match.anchor.contextAfter).toBe(" is authoritative — canonical an");
  });

  test("paragraphHash is set and matches the containing paragraph", () => {
    const match = buildAnchor(doc, "reanchoring engine")!;
    expect(match.anchor.paragraphHash).toBe(paragraphHash(match.paragraph.text));
  });

  test("first occurrence wins on duplicate snippets", () => {
    const dupDoc = docFromParagraphs(["alpha beta", "beta gamma", "delta beta"]);
    const match = buildAnchor(dupDoc, "beta")!;
    expect(match.paragraph.paragraphIndex).toBe(0);
    expect(match.anchor.structuralPosition?.offset).toBe(6);
  });
});

describe("orphanAnchor", () => {
  test("preserves the snippet without structural position", () => {
    const a = orphanAnchor("text that vanished");
    expect(a.quotedText).toBe("text that vanished");
    expect(a.structuralPosition).toBeUndefined();
    expect(a.paragraphHash).toBeUndefined();
  });
});

describe("buildAnchor — region-aware", () => {
  test("locates a snippet in a header (not just body)", () => {
    const doc = multiRegionDoc({
      body: ["Body content here."],
      header: { id: "h1", paragraphs: ["Confidential — do not share."] },
    });
    const m = buildAnchor(doc, "Confidential");
    expect(m).not.toBeNull();
    expect(m!.paragraph.region).toBe("header");
    expect(m!.paragraph.regionId).toBe("h1");
    expect(m!.anchor.structuralPosition?.region).toBe("header");
    expect(m!.anchor.structuralPosition?.regionId).toBe("h1");
  });

  test("locates a snippet in a footer", () => {
    const doc = multiRegionDoc({
      body: ["Body."],
      footer: { id: "f1", paragraphs: ["Page 1 of 1"] },
    });
    const m = buildAnchor(doc, "Page 1");
    expect(m).not.toBeNull();
    expect(m!.paragraph.region).toBe("footer");
    expect(m!.paragraph.regionId).toBe("f1");
  });

  test("locates a snippet in a footnote", () => {
    const doc = multiRegionDoc({
      body: ["Body."],
      footnote: { id: "fn-1", paragraphs: ["See appendix B."] },
    });
    const m = buildAnchor(doc, "appendix B");
    expect(m).not.toBeNull();
    expect(m!.paragraph.region).toBe("footnote");
    expect(m!.paragraph.regionId).toBe("fn-1");
  });

  test("body anchor omits region/regionId for back-compat", () => {
    const doc = multiRegionDoc({ body: ["Just body content."] });
    const m = buildAnchor(doc, "body content");
    expect(m).not.toBeNull();
    expect(m!.paragraph.region).toBe("body");
    // CommentAnchor.structuralPosition omits region for body (back-compat:
    // pre-region-awareness anchors had no region field).
    expect(m!.anchor.structuralPosition?.region).toBeUndefined();
    expect(m!.anchor.structuralPosition?.regionId).toBeUndefined();
  });
});

describe("anchorAt", () => {
  const para: RegionParagraphText = {
    paragraphIndex: 2,
    text: "The quick brown fox jumps over the lazy dog.",
    startIndex: 100,
    endIndex: 144,
    region: "body",
    regionId: "",
  };

  test("body paragraph: omits region from structuralPosition", () => {
    const a = anchorAt("brown fox", para, 10);
    expect(a.structuralPosition).toEqual({ paragraphIndex: 2, offset: 10 });
  });

  test("explicit region/regionId overrides paragraph defaults", () => {
    const a = anchorAt("brown fox", para, 10, { region: "header", regionId: "h1" });
    expect(a.structuralPosition?.region).toBe("header");
    expect(a.structuralPosition?.regionId).toBe("h1");
  });

  test("matchLen drives contextAfter slicing for fuzzy matches", () => {
    // Use matchLen larger than quoted.length to simulate Myers-fuzzy matching
    // a span that includes inserted target characters.
    const a = anchorAt("brown", para, 10, { matchLen: 9 }); // covers "brown fox"
    expect(a.contextAfter).toBe(" jumps over the lazy dog.");
  });

  test("contextBefore captures up to CONTEXT_CHARS before offset", () => {
    const a = anchorAt("fox", para, 16);
    expect(a.contextBefore).toBe("The quick brown ");
  });
});
