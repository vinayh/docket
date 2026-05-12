import { describe, expect, test } from "bun:test";
import { anchorAt, orphanAnchor, paragraphHash } from "./anchor.ts";
import type { RegionParagraphText } from "../google/docs.ts";

describe("paragraphHash", () => {
  test("is stable for the same text", () => {
    expect(paragraphHash("hello world")).toBe(paragraphHash("hello world"));
  });

  test("differs for different text", () => {
    expect(paragraphHash("hello")).not.toBe(paragraphHash("hello world"));
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
