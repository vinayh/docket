import { describe, expect, test } from "bun:test";
import { paragraphHash } from "../anchor.ts";
import { buildAnchor } from "./anchor-build.ts";

describe("buildAnchor", () => {
  test("body range: anchor carries paragraph hash + structuralPosition without region tag", () => {
    const a = buildAnchor({
      quotedText: "brown fox",
      paragraphText: "The quick brown fox jumps over the lazy dog.",
      region: "body",
      regionId: "",
      paragraphIndex: 2,
      offset: 10,
      length: 9,
    });
    expect(a.quotedText).toBe("brown fox");
    expect(a.paragraphHash).toBe(
      paragraphHash("The quick brown fox jumps over the lazy dog."),
    );
    expect(a.structuralPosition).toEqual({ paragraphIndex: 2, offset: 10 });
  });

  test("non-body region: structuralPosition carries region + regionId", () => {
    const a = buildAnchor({
      quotedText: "note",
      paragraphText: "A footer note here.",
      region: "footer",
      regionId: "f1",
      paragraphIndex: 0,
      offset: 9,
      length: 4,
    });
    expect(a.structuralPosition?.region).toBe("footer");
    expect(a.structuralPosition?.regionId).toBe("f1");
  });

  test("captures contextBefore/contextAfter around the quoted span", () => {
    const a = buildAnchor({
      quotedText: "brown",
      paragraphText: "The quick brown fox jumps over the lazy dog.",
      region: "body",
      regionId: "",
      paragraphIndex: 0,
      offset: 10,
      length: 5,
    });
    expect(a.contextBefore).toBe("The quick ");
    expect(a.contextAfter).toBe(" fox jumps over the lazy dog.");
  });

  test("length > quotedText.length lets fuzzy callers cover an expanded target span", () => {
    // Mirrors the Pass-3 reanchor case where matchLen reaches past the source
    // quoted text to include inserted target characters between equal segments.
    const a = buildAnchor({
      quotedText: "brown",
      paragraphText: "The quick brown fox jumps over the lazy dog.",
      region: "body",
      regionId: "",
      paragraphIndex: 0,
      offset: 10,
      length: 9,
    });
    // contextAfter starts after offset+length=19, i.e. " jumps over the lazy dog."
    expect(a.contextAfter).toBe(" jumps over the lazy dog.");
  });
});
