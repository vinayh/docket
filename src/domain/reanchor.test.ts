import { describe, expect, test } from "bun:test";
import {
  CLEAN_THRESHOLD,
  FUZZY_THRESHOLD,
  longestCommonSubstring,
  reanchor,
} from "./reanchor.ts";
import { paragraphHash } from "./anchor.ts";
import type { Document } from "../google/docs.ts";
import type { CommentAnchor } from "../db/schema.ts";

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

describe("longestCommonSubstring", () => {
  test("returns zero length for disjoint strings", () => {
    expect(longestCommonSubstring("abc", "xyz")).toEqual({ offsetInB: 0, length: 0 });
  });

  test("returns the longest contiguous match and its offset in b", () => {
    const r = longestCommonSubstring("hello world", "say hello there");
    expect(r.length).toBe(6); // "hello "
    expect(r.offsetInB).toBe(4);
  });

  test("handles empty inputs", () => {
    expect(longestCommonSubstring("", "abc")).toEqual({ offsetInB: 0, length: 0 });
    expect(longestCommonSubstring("abc", "")).toEqual({ offsetInB: 0, length: 0 });
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
});
