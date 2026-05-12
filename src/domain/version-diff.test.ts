import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import { account } from "../db/schema.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
import { getVersionDiffPayload, summarizeDocument } from "./version-diff.ts";
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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seedDriveCredential(userId: string): Promise<void> {
  await db.insert(account).values({
    userId,
    providerId: "google",
    accountId: `sub-${userId}`,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshToken: await encryptWithMaster("1//rt-test"),
  });
}

/**
 * Stub Google's `oauth2/token` refresh and `docs.googleapis.com/v1/documents/<id>`
 * GET. Returns the doc payloads keyed by id; throws when an unexpected URL is hit
 * so tests fail loudly if the wrong path is exercised.
 */
function stubGoogle(byDocId: Record<string, Document>) {
  setFetch(async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-test",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/drive.file",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const m = /docs\.googleapis\.com\/v1\/documents\/([^/?]+)/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const doc = byDocId[id];
      if (!doc) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

describe("getVersionDiffPayload", () => {
  beforeEach(cleanDb);

  test("returns null when the from-version is missing", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const to = await seedVersion({ projectId: p.id, createdByUserId: u.id });
    expect(
      await getVersionDiffPayload({
        fromVersionId: crypto.randomUUID(),
        toVersionId: to.id,
        userId: u.id,
      }),
    ).toBeNull();
  });

  test("returns null when the to-version is missing", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const from = await seedVersion({ projectId: p.id, createdByUserId: u.id });
    expect(
      await getVersionDiffPayload({
        fromVersionId: from.id,
        toVersionId: crypto.randomUUID(),
        userId: u.id,
      }),
    ).toBeNull();
  });

  test("returns null when the caller does not own the project (cross-tenant)", async () => {
    const owner = await seedUser();
    const p = await seedProject({ ownerUserId: owner.id });
    const from = await seedVersion({ projectId: p.id, createdByUserId: owner.id });
    const to = await seedVersion({ projectId: p.id, createdByUserId: owner.id });

    const other = await seedUser();
    expect(
      await getVersionDiffPayload({
        fromVersionId: from.id,
        toVersionId: to.id,
        userId: other.id,
      }),
    ).toBeNull();
  });

  test("returns null when the two versions belong to different projects", async () => {
    const u = await seedUser();
    const a = await seedProject({ ownerUserId: u.id });
    const b = await seedProject({ ownerUserId: u.id });
    const va = await seedVersion({ projectId: a.id, createdByUserId: u.id });
    const vb = await seedVersion({ projectId: b.id, createdByUserId: u.id });

    expect(
      await getVersionDiffPayload({
        fromVersionId: va.id,
        toVersionId: vb.id,
        userId: u.id,
      }),
    ).toBeNull();
  });

  test("happy path: returns paragraph summaries for both versions", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({ ownerUserId: u.id });
    const from = await seedVersion({
      projectId: p.id,
      createdByUserId: u.id,
      label: "v1",
      googleDocId: "doc-from",
    });
    const to = await seedVersion({
      projectId: p.id,
      createdByUserId: u.id,
      label: "v2",
      googleDocId: "doc-to",
    });

    stubGoogle({
      "doc-from": {
        documentId: "doc-from",
        title: "v1",
        body: {
          content: [
            {
              paragraph: {
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                elements: [{ textRun: { content: "hello world\n", textStyle: {} } }],
              },
            },
          ],
        },
      },
      "doc-to": {
        documentId: "doc-to",
        title: "v2",
        body: {
          content: [
            {
              paragraph: {
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                elements: [{ textRun: { content: "hello there\n", textStyle: {} } }],
              },
            },
          ],
        },
      },
    });

    const payload = await getVersionDiffPayload({
      fromVersionId: from.id,
      toVersionId: to.id,
      userId: u.id,
    });
    expect(payload).not.toBeNull();
    expect(payload!.from.versionId).toBe(from.id);
    expect(payload!.from.label).toBe("v1");
    expect(payload!.from.googleDocId).toBe("doc-from");
    expect(payload!.from.paragraphs[0]!.plaintext).toBe("hello world");
    expect(payload!.to.versionId).toBe(to.id);
    expect(payload!.to.paragraphs[0]!.plaintext).toBe("hello there");
  });
});

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
