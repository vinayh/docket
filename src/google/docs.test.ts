import { afterEach, describe, expect, test } from "bun:test";
import { setFetch } from "../../test/fetch.ts";
import type { TokenProvider } from "./api.ts";
import {
  batchUpdate,
  createDocument,
  extractAllParagraphs,
  extractPlainText,
  op,
  type Document,
} from "./docs.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const tp: TokenProvider = {
  async getAccessToken() {
    return "access-test";
  },
  async refreshAccessToken() {
    return "access-test";
  },
};

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

interface CapturedReq {
  url: string;
  method: string | undefined;
  contentType: string | null;
  body: string | null;
}

function captureNext(response: Response): { reqs: CapturedReq[] } {
  const reqs: CapturedReq[] = [];
  setFetch(async (input, init) => {
    reqs.push({
      url: String(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get("content-type"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return response;
  });
  return { reqs };
}

describe("createDocument", () => {
  test("POSTs the title to /v1/documents and returns the parsed Document", async () => {
    const { reqs } = captureNext(
      new Response(
        JSON.stringify({ documentId: "new-doc-id", title: "My Doc" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const doc = await createDocument(tp, { title: "My Doc" });
    expect(doc.documentId).toBe("new-doc-id");
    expect(doc.title).toBe("My Doc");
    expect(reqs[0]!.url).toBe("https://docs.googleapis.com/v1/documents");
    expect(reqs[0]!.method).toBe("POST");
    expect(reqs[0]!.contentType).toBe("application/json");
    expect(JSON.parse(reqs[0]!.body as string)).toEqual({ title: "My Doc" });
  });
});

describe("batchUpdate", () => {
  test("POSTs to /v1/documents/<id>:batchUpdate with requests array", async () => {
    const { reqs } = captureNext(
      new Response(
        JSON.stringify({ documentId: "doc-1", replies: [{}, {}] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const resp = await batchUpdate(tp, "doc-1", [
      op.insertText("hi", 1),
      op.deleteContentRange(2, 5),
    ]);
    expect(resp.documentId).toBe("doc-1");
    expect(resp.replies).toHaveLength(2);
    expect(reqs[0]!.url).toBe(
      "https://docs.googleapis.com/v1/documents/doc-1:batchUpdate",
    );
    expect(reqs[0]!.method).toBe("POST");
    const body = JSON.parse(reqs[0]!.body as string);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toEqual({
      insertText: { text: "hi", location: { index: 1 } },
    });
  });

  test("URL-encodes the documentId (no path traversal via slashes)", async () => {
    const { reqs } = captureNext(
      new Response(JSON.stringify({ documentId: "x/y" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await batchUpdate(tp, "doc/with/slash", []);
    expect(reqs[0]!.url).toContain("/v1/documents/doc%2Fwith%2Fslash:batchUpdate");
  });

  test("passes writeControl through when provided", async () => {
    const { reqs } = captureNext(
      new Response(JSON.stringify({ documentId: "d" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await batchUpdate(tp, "d", [op.insertText("x", 1)], {
      requiredRevisionId: "rev-1",
    });
    const body = JSON.parse(reqs[0]!.body as string);
    expect(body.writeControl).toEqual({ requiredRevisionId: "rev-1" });
  });
});
