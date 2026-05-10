import { describe, expect, test } from "bun:test";
import { summarizeDocument } from "./version-diff.ts";
import type { Document } from "../google/docs.ts";

function paragraph(opts: {
  text: string;
  namedStyleType?: string;
  bold?: boolean;
  italic?: boolean;
}): Document["body"] extends infer B
  ? B extends { content: (infer E)[] }
    ? E
    : never
  : never {
  return {
    paragraph: {
      paragraphStyle: opts.namedStyleType ? { namedStyleType: opts.namedStyleType } : {},
      elements: [
        {
          textRun: {
            content: opts.text + "\n",
            textStyle: {
              ...(opts.bold ? { bold: true } : {}),
              ...(opts.italic ? { italic: true } : {}),
            },
          },
        },
      ],
    },
  };
}

function makeDoc(paragraphs: ReturnType<typeof paragraph>[]): Document {
  return {
    documentId: "doc-1",
    title: "test",
    body: { content: paragraphs },
  };
}

describe("summarizeDocument", () => {
  test("strips the trailing paragraph newline", () => {
    const doc = makeDoc([paragraph({ text: "hello" })]);
    const out = summarizeDocument(doc);
    expect(out).toHaveLength(1);
    expect(out[0]!.plaintext).toBe("hello");
  });

  test("captures namedStyleType for heading detection", () => {
    const doc = makeDoc([
      paragraph({ text: "Title", namedStyleType: "TITLE" }),
      paragraph({ text: "body", namedStyleType: "NORMAL_TEXT" }),
    ]);
    const out = summarizeDocument(doc);
    expect(out[0]!.namedStyleType).toBe("TITLE");
    expect(out[1]!.namedStyleType).toBe("NORMAL_TEXT");
  });

  test("style flags propagate to RunSummary; default-styled runs report null", () => {
    const doc = makeDoc([
      paragraph({ text: "bold text", bold: true }),
      paragraph({ text: "plain text" }),
    ]);
    const out = summarizeDocument(doc);
    expect(out[0]!.runs[0]!.style).toEqual({ bold: true });
    expect(out[1]!.runs[0]!.style).toBeNull();
  });

  test("skips structural elements that aren't paragraphs (tables, section breaks)", () => {
    const doc: Document = {
      documentId: "doc-2",
      title: "t",
      body: {
        content: [
          paragraph({ text: "before" }),
          { sectionBreak: {} },
          { table: {} },
          paragraph({ text: "after" }),
        ],
      },
    };
    const out = summarizeDocument(doc);
    expect(out.map((p) => p.plaintext)).toEqual(["before", "after"]);
  });

  test("multiple runs in one paragraph keep order + concatenate into plaintext", () => {
    const doc: Document = {
      documentId: "doc-3",
      title: "t",
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: "Hello, ", textStyle: {} } },
                { textRun: { content: "world", textStyle: { bold: true } } },
                { textRun: { content: "!\n", textStyle: {} } },
              ],
            },
          },
        ],
      },
    };
    const out = summarizeDocument(doc);
    expect(out[0]!.plaintext).toBe("Hello, world!");
    expect(out[0]!.runs).toHaveLength(3);
    expect(out[0]!.runs[1]!.style).toEqual({ bold: true });
  });
});
