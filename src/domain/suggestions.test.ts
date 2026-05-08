import { describe, expect, test } from "bun:test";
import { extractSuggestions } from "./suggestions.ts";
import type { Document, ParagraphElement, StructuralElement } from "../google/docs.ts";

interface RunSpec {
  text: string;
  insertIds?: string[];
  deleteIds?: string[];
}

function paragraph(runs: RunSpec[]): ParagraphElement[] {
  return runs.map((r) => ({
    textRun: {
      content: r.text,
      ...(r.insertIds ? { suggestedInsertionIds: r.insertIds } : {}),
      ...(r.deleteIds ? { suggestedDeletionIds: r.deleteIds } : {}),
    },
  }));
}

function paragraphsAsContent(paragraphs: ParagraphElement[][]): StructuralElement[] {
  return paragraphs.map((elements) => ({ paragraph: { elements } }));
}

function docFrom(paragraphs: ParagraphElement[][]): Document {
  return {
    documentId: "test",
    title: "test",
    body: { content: paragraphsAsContent(paragraphs) },
  };
}

describe("extractSuggestions", () => {
  test("returns nothing for a doc with no suggestions", () => {
    const doc = docFrom([paragraph([{ text: "Plain prose.\n" }])]);
    expect(extractSuggestions(doc)).toEqual([]);
  });

  test("captures a single-run insertion", () => {
    const doc = docFrom([
      paragraph([
        { text: "Hello " },
        { text: "world", insertIds: ["s1"] },
        { text: ".\n" },
      ]),
    ]);
    const spans = extractSuggestions(doc);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      id: "s1",
      kind: "suggestion_insert",
      paragraphIndex: 0,
      offset: 6,
      length: 5,
      text: "world",
    });
  });

  test("captures a single-run deletion", () => {
    const doc = docFrom([
      paragraph([
        { text: "Keep " },
        { text: "remove me", deleteIds: ["s2"] },
        { text: " and rest.\n" },
      ]),
    ]);
    const spans = extractSuggestions(doc);
    expect(spans).toEqual([
      {
        id: "s2",
        kind: "suggestion_delete",
        region: "body",
        regionId: "",
        paragraphIndex: 0,
        paragraphText: "Keep remove me and rest.",
        offset: 5,
        length: 9,
        text: "remove me",
      },
    ]);
  });

  test("coalesces consecutive runs sharing a suggestion id", () => {
    const doc = docFrom([
      paragraph([
        { text: "intro " },
        { text: "bold ", insertIds: ["s3"] },
        { text: "italic", insertIds: ["s3"] },
        { text: " end.\n" },
      ]),
    ]);
    const spans = extractSuggestions(doc);
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span!.text).toBe("bold italic");
    expect(span!.length).toBe(11);
    expect(span!.offset).toBe(6);
  });

  test("emits separate spans per paragraph for cross-paragraph suggestions", () => {
    const doc = docFrom([
      paragraph([{ text: "first part", insertIds: ["s4"] }, { text: "\n" }]),
      paragraph([{ text: "second part", insertIds: ["s4"] }, { text: "\n" }]),
    ]);
    const spans = extractSuggestions(doc);
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.paragraphIndex)).toEqual([0, 1]);
    expect(spans.every((s) => s.id === "s4")).toBe(true);
  });

  test("emits two spans for a run carrying both insertion and deletion ids", () => {
    const doc = docFrom([
      paragraph([
        { text: "hello " },
        { text: "rewritten", insertIds: ["i1"], deleteIds: ["d1"] },
        { text: ".\n" },
      ]),
    ]);
    const spans = extractSuggestions(doc);
    expect(spans).toHaveLength(2);
    const kinds = spans.map((s) => s.kind).sort();
    expect(kinds).toEqual(["suggestion_delete", "suggestion_insert"]);
  });

  test("ignores style-change suggestions (non-id flags)", () => {
    const doc = docFrom([paragraph([{ text: "styled\n" }])]);
    expect(extractSuggestions(doc)).toEqual([]);
  });

  test("body spans are tagged region='body'", () => {
    const doc = docFrom([paragraph([{ text: "x", insertIds: ["b1"] }, { text: "\n" }])]);
    expect(extractSuggestions(doc)[0]).toMatchObject({
      region: "body",
      regionId: "",
    });
  });

  test("walks footers and tags region/regionId", () => {
    const doc: Document = {
      documentId: "t",
      title: "t",
      body: { content: [] },
      footers: {
        "kix.f1": {
          footerId: "kix.f1",
          content: paragraphsAsContent([
            paragraph([{ text: "test", insertIds: ["s.foot"] }, { text: "\n" }]),
          ]),
        },
      },
    };
    const spans = extractSuggestions(doc);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      id: "s.foot",
      kind: "suggestion_insert",
      region: "footer",
      regionId: "kix.f1",
      paragraphIndex: 0,
      text: "test",
    });
  });

  test("walks headers and footnotes", () => {
    const doc: Document = {
      documentId: "t",
      title: "t",
      body: { content: [] },
      headers: {
        "kix.h1": {
          content: paragraphsAsContent([
            paragraph([{ text: "header", deleteIds: ["s.h"] }, { text: "\n" }]),
          ]),
        },
      },
      footnotes: {
        "kix.fn1": {
          content: paragraphsAsContent([
            paragraph([{ text: "fn", insertIds: ["s.fn"] }, { text: "\n" }]),
          ]),
        },
      },
    };
    const spans = extractSuggestions(doc);
    const byRegion = Object.fromEntries(spans.map((s) => [s.region, s]));
    expect(byRegion.header).toMatchObject({ id: "s.h", regionId: "kix.h1" });
    expect(byRegion.footnote).toMatchObject({ id: "s.fn", regionId: "kix.fn1" });
  });

  test("paragraphIndex is local to the region (body para 0 and footer para 0 don't collide)", () => {
    const doc: Document = {
      documentId: "t",
      title: "t",
      body: {
        content: paragraphsAsContent([
          paragraph([{ text: "body", insertIds: ["s.b"] }, { text: "\n" }]),
        ]),
      },
      footers: {
        "kix.f1": {
          content: paragraphsAsContent([
            paragraph([{ text: "foot", insertIds: ["s.f"] }, { text: "\n" }]),
          ]),
        },
      },
    };
    const spans = extractSuggestions(doc);
    expect(spans.every((s) => s.paragraphIndex === 0)).toBe(true);
    expect(spans.map((s) => s.region).sort()).toEqual(["body", "footer"]);
  });
});
