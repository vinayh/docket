import { describe, expect, test } from "bun:test";
import { buildAnchor, orphanAnchor, paragraphHash } from "./anchor.ts";
import type { Document } from "../google/docs.ts";

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
            elements: [
              {
                startIndex: start,
                endIndex: end,
                textRun: { content },
              },
            ],
          },
        };
      }),
    },
  };
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
    "Introduction to Docket.",
    "The reanchoring engine is authoritative — canonical anchors live in Docket's own schema.",
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
