import { describe, expect, test } from "bun:test";
import {
  CLEAN_THRESHOLD,
  FUZZY_THRESHOLD,
  matchSpan,
  reanchor,
} from "./reanchor.ts";
import { paragraphHash } from "./anchor.ts";
import type { Document, StructuralElement } from "../google/docs.ts";
import type { CommentAnchor } from "../db/schema.ts";

function paragraphsToContent(paragraphs: string[]): StructuralElement[] {
  let cursor = 1;
  return paragraphs.map((text) => {
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
  });
}

function docFromParagraphs(paragraphs: string[]): Document {
  return {
    documentId: "test",
    title: "test",
    body: { content: paragraphsToContent(paragraphs) },
  };
}

const PARAGRAPHS_V1 = [
  "Introduction to Docket.",
  "The reanchoring engine is authoritative — canonical anchors live in Docket's own schema.",
  "Final paragraph with no special content.",
];

function anchorFor(paragraphs: string[], paraIdx: number, snippet: string): CommentAnchor {
  const p = paragraphs[paraIdx]!;
  const offset = p.indexOf(snippet);
  return {
    quotedText: snippet,
    contextBefore: p.slice(Math.max(0, offset - 32), offset) || undefined,
    contextAfter: p.slice(offset + snippet.length, offset + snippet.length + 32) || undefined,
    paragraphHash: paragraphHash(p),
    structuralPosition: { paragraphIndex: paraIdx, offset },
  };
}

describe("matchSpan", () => {
  test("returns null for disjoint strings", () => {
    expect(matchSpan("abc", "xyz")).toBeNull();
  });

  test("spans across an inserted word so the matched region covers all matches", () => {
    // Source content appears verbatim in target with one extra word in the middle.
    // Span should run from the first match to the last, including the insertion.
    const r = matchSpan("You can edit this freely", "You can probably edit this freely");
    expect(r).not.toBeNull();
    expect(r!.totalMatched).toBe(24);
    expect(r!.spanStart).toBe(0);
    expect(r!.spanEnd).toBe(33); // full target length
  });

  test("matches a contiguous substring", () => {
    const r = matchSpan("hello world", "say hello world there");
    expect(r).not.toBeNull();
    expect(r!.totalMatched).toBe(11);
    expect(r!.spanStart).toBe(4);
    expect(r!.spanEnd).toBe(15);
  });
});

describe("reanchor", () => {
  test("clean = 100 when paragraph hash + quoted text both intact", () => {
    const doc = docFromParagraphs(PARAGRAPHS_V1);
    const source = anchorFor(PARAGRAPHS_V1, 1, "reanchoring engine");
    const r = reanchor(doc, source);
    expect(r.confidence).toBe(100);
    expect(r.status).toBe("clean");
    expect(r.anchor.structuralPosition?.paragraphIndex).toBe(1);
  });

  test("clean ≥ 90 when paragraph drifted but quoted text + context intact", () => {
    const v2 = [
      "Introduction to Docket — revised.", // paragraph 0 edited → hash changed
      PARAGRAPHS_V1[1]!,
      PARAGRAPHS_V1[2]!,
    ];
    const doc = docFromParagraphs(v2);
    const source = anchorFor(PARAGRAPHS_V1, 1, "reanchoring engine");
    const r = reanchor(doc, source);
    expect(r.confidence).toBeGreaterThanOrEqual(CLEAN_THRESHOLD);
    expect(r.status).toBe("clean");
    expect(r.anchor.structuralPosition?.paragraphIndex).toBe(1);
  });

  test("fuzzy when quoted text was edited (LCS path)", () => {
    const v2 = [
      PARAGRAPHS_V1[0]!,
      "The re-anchoring engine is authoritative — canonical anchors live in Docket's own schema.",
      PARAGRAPHS_V1[2]!,
    ];
    const doc = docFromParagraphs(v2);
    const source = anchorFor(PARAGRAPHS_V1, 1, "reanchoring engine");
    const r = reanchor(doc, source);
    expect(r.status).toBe("fuzzy");
    expect(r.confidence).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    expect(r.confidence).toBeLessThan(CLEAN_THRESHOLD);
    expect(r.anchor.structuralPosition?.paragraphIndex).toBe(1);
  });

  test("orphan when nothing close enough", () => {
    const v2 = ["Completely different content.", "Nothing alike.", "Goodbye."];
    const doc = docFromParagraphs(v2);
    const source = anchorFor(PARAGRAPHS_V1, 1, "reanchoring engine");
    const r = reanchor(doc, source);
    expect(r.status).toBe("orphaned");
    expect(r.confidence).toBe(0);
    expect(r.anchor.structuralPosition).toBeUndefined();
  });

  test("ambiguous duplicates pick the closest paragraphIndex to the source", () => {
    // No paragraph in v2 hashes the same as the source's paragraph, so pass-1 misses
    // and pass-2 (exact substring, multiple candidates) decides. Both p1 and p3 contain
    // "beta"; source's paragraphIndex=2 → p3 (index 3) is closer than p1 (index 1).
    const v2 = ["alpha beta one", "gamma here", "more text", "delta beta two", "epsilon"];
    const doc = docFromParagraphs(v2);
    const source: CommentAnchor = {
      quotedText: "beta",
      paragraphHash: paragraphHash("ORIGINAL paragraph that no longer exists"),
      structuralPosition: { paragraphIndex: 3, offset: 0 },
    };
    const r = reanchor(doc, source);
    expect(r.anchor.structuralPosition?.paragraphIndex).toBe(3);
    // ambiguous (multiple exact matches) → 85 base, status fuzzy
    expect(r.status).toBe("fuzzy");
    expect(r.confidence).toBeLessThan(CLEAN_THRESHOLD);
    expect(r.confidence).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
  });

  test("empty quoted text is an immediate orphan", () => {
    const doc = docFromParagraphs(PARAGRAPHS_V1);
    const r = reanchor(doc, { quotedText: "" });
    expect(r.status).toBe("orphaned");
    expect(r.confidence).toBe(0);
  });

  test("Pass 3 fuzzy match never reports clean (status guard)", () => {
    // Pre-fix the Pass 3 ternary `confidence >= CLEAN_THRESHOLD ? "clean" : "fuzzy"`
    // was unreachable on the clean side (confidence is capped at 80) but lived
    // in the code anyway. Regression: any time we land in Pass 3 (no exact
    // substring match in any region), the status is "fuzzy" or "orphaned"
    // — never "clean".
    const targetParas = [
      // No exact substring of the source's quotedText, but enough overlap to
      // trigger Pass 3. Source: "the reanchoring engine is authoritative".
      "the re-anchoring engine is authoritative — canonical anchors live elsewhere.",
    ];
    const doc = docFromParagraphs(targetParas);
    const source: CommentAnchor = {
      quotedText: "the reanchoring engine is authoritative",
      paragraphHash: paragraphHash("ORIGINAL paragraph that no longer exists"),
      structuralPosition: { paragraphIndex: 0, offset: 0 },
    };
    const r = reanchor(doc, source);
    expect(r.status).not.toBe("clean");
    expect(r.confidence).toBeLessThan(CLEAN_THRESHOLD);
  });
});

describe("reanchor — region-aware", () => {
  function docWithBodyAndHeader(opts: {
    body: string[];
    headerId: string;
    headerParas: string[];
  }): Document {
    return {
      documentId: "test",
      title: "test",
      body: { content: paragraphsToContent(opts.body) },
      headers: {
        [opts.headerId]: {
          headerId: opts.headerId,
          content: paragraphsToContent(opts.headerParas),
        },
      },
    };
  }

  test("header anchor matches in target's header (not body) when both contain the quoted text", () => {
    // Pre-fix `extractParagraphs` only walked body, so a header anchor would
    // either fail Pass 1 (header paragraphs invisible) and slide to Pass 2
    // against body, or just orphan. With region awareness the source's
    // region is searched first and a header→header match wins.
    const doc = docWithBodyAndHeader({
      body: ["Confidential — do not share.", "Body content."],
      headerId: "h1",
      headerParas: ["Confidential — do not share."],
    });
    const headerText = "Confidential — do not share.";
    const source: CommentAnchor = {
      quotedText: "Confidential",
      paragraphHash: paragraphHash(headerText),
      structuralPosition: {
        region: "header",
        regionId: "h1",
        paragraphIndex: 0,
        offset: 0,
      },
    };
    const r = reanchor(doc, source);
    expect(r.status).toBe("clean");
    expect(r.paragraph?.region).toBe("header");
    expect(r.paragraph?.regionId).toBe("h1");
  });

  test("header anchor falls back to body only when its region has no match", () => {
    // Source claims region=header but the target doc's header doesn't
    // contain the quoted text — Pass 2 against body finds it. We accept the
    // cross-region match (better fuzzy hit than no hit), but the result
    // points at body, not the missing header paragraph.
    const doc = docWithBodyAndHeader({
      body: ["Welcome to the report."],
      headerId: "h1",
      headerParas: ["Different header content."],
    });
    const source: CommentAnchor = {
      quotedText: "Welcome to the report.",
      paragraphHash: paragraphHash("nope"),
      structuralPosition: {
        region: "header",
        regionId: "h1",
        paragraphIndex: 0,
        offset: 0,
      },
    };
    const r = reanchor(doc, source);
    expect(r.paragraph?.region).toBe("body");
    expect(r.confidence).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
  });

  test("body anchor doesn't accidentally land in a header that shares the same text", () => {
    // Body anchor + body match available → don't migrate to a same-text
    // header (would happen if extractAllParagraphs reordered regions).
    const doc = docWithBodyAndHeader({
      body: ["Confidential — do not share."],
      headerId: "h1",
      headerParas: ["Confidential — do not share."],
    });
    const bodyText = "Confidential — do not share.";
    const source: CommentAnchor = {
      quotedText: "Confidential",
      paragraphHash: paragraphHash(bodyText),
      structuralPosition: { paragraphIndex: 0, offset: 0 }, // region=body (default)
    };
    const r = reanchor(doc, source);
    expect(r.paragraph?.region).toBe("body");
  });
});
