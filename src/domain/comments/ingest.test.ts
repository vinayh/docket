import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import {
  cleanDb,
  seedProject,
  seedUser,
  seedVersion,
} from "../../../test/db.ts";
import { setFetch } from "../../../test/fetch.ts";
import { db } from "../../db/client.ts";
import { encryptWithMaster } from "../../auth/encryption.ts";
import { account, canonicalComment } from "../../db/schema.ts";
import { ingestVersionComments } from "./ingest.ts";

beforeEach(cleanDb);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;

function docXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${NS}><w:body>${body}</w:body></w:document>`;
}

function commentsXml(xs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:comments ${NS}>${xs}</w:comments>`;
}

function makeDocxBytes(parts: {
  document: string;
  comments?: string;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "word/document.xml": strToU8(parts.document),
  };
  if (parts.comments) files["word/comments.xml"] = strToU8(parts.comments);
  return zipSync(files);
}

interface FixtureOpts {
  docxBytes: Uint8Array;
  driveComments: unknown[];
}

function stubGoogle(byDocId: Record<string, FixtureOpts>): void {
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
    // /files/<id>/export?mimeType=…wordprocessingml.document → docx bytes
    const exportMatch = /\/files\/([^/]+)\/export\?/.exec(url);
    if (exportMatch) {
      const id = decodeURIComponent(exportMatch[1]!);
      const fx = byDocId[id];
      if (!fx) return new Response("nope", { status: 404 });
      // TS 6 narrows Uint8Array to `Uint8Array<ArrayBufferLike>` (the union
      // covering SharedArrayBuffer), which Response's BodyInit overloads
      // refuse. `fflate.zipSync` always returns an ArrayBuffer-backed view
      // — assert the narrower type at this boundary.
      return new Response(fx.docxBytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      });
    }
    // /files/<id>/comments → DriveComment JSON
    const listMatch = /\/files\/([^/]+)\/comments\?/.exec(url);
    if (listMatch) {
      const id = decodeURIComponent(listMatch[1]!);
      const fx = byDocId[id];
      if (!fx) return new Response("nope", { status: 404 });
      return new Response(
        JSON.stringify({ comments: fx.driveComments }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in ingest test: ${url}`);
  });
}

async function seedDriveCredential(userId: string): Promise<void> {
  await db.insert(account).values({
    userId,
    providerId: "google",
    accountId: `sub-${userId}`,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshToken: await encryptWithMaster("1//rt-test"),
  });
}

async function fixtureHarness(): Promise<{
  versionId: string;
  projectId: string;
  googleDocId: string;
}> {
  const owner = await seedUser();
  await seedDriveCredential(owner.id);
  const proj = await seedProject({ ownerUserId: owner.id });
  const ver = await seedVersion({
    projectId: proj.id,
    createdByUserId: owner.id,
    googleDocId: "doc-fixture",
  });
  return { versionId: ver.id, projectId: proj.id, googleDocId: ver.googleDocId };
}

describe("ingestVersionComments", () => {
  test("plain comment → 1 canonical row, fetched=1 inserted=1", async () => {
    const h = await fixtureHarness();
    stubGoogle({
      [h.googleDocId]: {
        docxBytes: makeDocxBytes({
          document: docXml(`
            <w:p>
              <w:r><w:t>Hello </w:t></w:r>
              <w:commentRangeStart w:id="0"/>
              <w:r><w:t>world</w:t></w:r>
              <w:commentRangeEnd w:id="0"/>
            </w:p>`),
          comments: commentsXml(`
            <w:comment w:id="0" w:author="Alice" w:date="2026-01-01T10:00:00Z">
              <w:p><w:r><w:t>looks good</w:t></w:r></w:p>
            </w:comment>`),
        }),
        driveComments: [
          {
            id: "drive-c-1",
            author: { displayName: "Alice", emailAddress: "alice@example.com", me: true },
            createdTime: "2026-01-01T10:00:00.123Z",
            content: "looks good",
          },
        ],
      },
    });
    const r = await ingestVersionComments(h.versionId);
    expect(r.fetched).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.alreadyPresent).toBe(0);
    expect(r.suggestionsInserted).toBe(0);
    expect(r.skippedOrphanMetadata).toBe(0);

    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, h.projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("looks good");
    expect(rows[0]?.kind).toBe("comment");
    // me=true → email recovered through the author index.
    expect(rows[0]?.originUserEmail).toBe("alice@example.com");
  });

  test("re-running is idempotent: alreadyPresent ticks, inserted stays 0", async () => {
    const h = await fixtureHarness();
    const fx = {
      docxBytes: makeDocxBytes({
        document: docXml(`
          <w:p>
            <w:commentRangeStart w:id="0"/>
            <w:r><w:t>quoted</w:t></w:r>
            <w:commentRangeEnd w:id="0"/>
          </w:p>`),
        comments: commentsXml(`
          <w:comment w:id="0" w:author="A" w:date="2026-01-01T10:00:00Z">
            <w:p><w:r><w:t>body</w:t></w:r></w:p>
          </w:comment>`),
      }),
      driveComments: [],
    };
    stubGoogle({ [h.googleDocId]: fx });
    const r1 = await ingestVersionComments(h.versionId);
    expect(r1.inserted).toBe(1);
    const r2 = await ingestVersionComments(h.versionId);
    expect(r2.inserted).toBe(0);
    expect(r2.alreadyPresent).toBe(1);

    const count = (
      await db
        .select()
        .from(canonicalComment)
        .where(eq(canonicalComment.projectId, h.projectId))
    ).length;
    expect(count).toBe(1);
  });

  test("orphan comment (metadata with no range markers) is skipped, not inserted", async () => {
    const h = await fixtureHarness();
    stubGoogle({
      [h.googleDocId]: {
        docxBytes: makeDocxBytes({
          // No commentRangeStart/End — the comment row in comments.xml has
          // no anchor in the body, headers, footers, or footnotes.
          document: docXml(`<w:p><w:r><w:t>plain text</w:t></w:r></w:p>`),
          comments: commentsXml(`
            <w:comment w:id="0" w:author="X" w:date="2026-01-01T10:00:00Z">
              <w:p><w:r><w:t>floating comment</w:t></w:r></w:p>
            </w:comment>`),
        }),
        driveComments: [],
      },
    });
    const r = await ingestVersionComments(h.versionId);
    // The docx assembler drops orphan-metadata comments entirely (they never
    // reach upsertCanonical), so neither `fetched` nor `inserted` ticks.
    expect(r.inserted).toBe(0);
    expect(r.skippedOrphanMetadata).toBe(0);
    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, h.projectId));
    expect(rows).toHaveLength(0);
  });

  test("suggestion + plain comment in the same version: both inserted, suggestionsInserted=1", async () => {
    const h = await fixtureHarness();
    stubGoogle({
      [h.googleDocId]: {
        docxBytes: makeDocxBytes({
          document: docXml(`
            <w:p>
              <w:ins w:id="42" w:author="Bob" w:date="2026-01-01T11:00:00Z">
                <w:r><w:t>inserted text</w:t></w:r>
              </w:ins>
              <w:commentRangeStart w:id="0"/>
              <w:r><w:t>quoted</w:t></w:r>
              <w:commentRangeEnd w:id="0"/>
            </w:p>`),
          comments: commentsXml(`
            <w:comment w:id="0" w:author="A" w:date="2026-01-01T10:00:00Z">
              <w:p><w:r><w:t>body</w:t></w:r></w:p>
            </w:comment>`),
        }),
        driveComments: [],
      },
    });
    const r = await ingestVersionComments(h.versionId);
    expect(r.inserted).toBe(2);
    expect(r.suggestionsInserted).toBe(1);
    const kinds = (
      await db
        .select({ k: canonicalComment.kind })
        .from(canonicalComment)
        .where(eq(canonicalComment.projectId, h.projectId))
    )
      .map((r) => r.k)
      .sort();
    expect(kinds).toEqual(["comment", "suggestion_insert"]);
  });

  test("reply to a suggestion: comment whose range overlaps a w:ins points at the suggestion's canonical row", async () => {
    const h = await fixtureHarness();
    stubGoogle({
      [h.googleDocId]: {
        docxBytes: makeDocxBytes({
          // Comment range wraps the w:ins → overlapsSuggestionId is set on
          // the docx comment, so phase B treats it as a suggestion reply.
          document: docXml(`
            <w:p>
              <w:commentRangeStart w:id="0"/>
              <w:ins w:id="7" w:author="Bob" w:date="2026-01-01T11:00:00Z">
                <w:r><w:t>edited</w:t></w:r>
              </w:ins>
              <w:commentRangeEnd w:id="0"/>
            </w:p>`),
          comments: commentsXml(`
            <w:comment w:id="0" w:author="A" w:date="2026-01-01T12:00:00Z">
              <w:p><w:r><w:t>nice edit</w:t></w:r></w:p>
            </w:comment>`),
        }),
        driveComments: [],
      },
    });
    const r = await ingestVersionComments(h.versionId);
    // 1 suggestion + 1 comment.
    expect(r.inserted).toBe(2);
    expect(r.suggestionsInserted).toBe(1);

    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, h.projectId));
    const suggestion = rows.find((r) => r.kind === "suggestion_insert");
    const reply = rows.find((r) => r.kind === "comment");
    expect(suggestion).toBeDefined();
    expect(reply).toBeDefined();
    expect(reply!.parentCommentId).toBe(suggestion!.id);
  });

  test("Drive reply chain reconstructs parent_comment_id from the Drive index", async () => {
    const h = await fixtureHarness();
    stubGoogle({
      [h.googleDocId]: {
        docxBytes: makeDocxBytes({
          // Two comments in OOXML — both anchor to the same text. Drive treats
          // them as parent + reply; the docx export flattens that into two
          // sibling rows. We reconstruct via driveLookupKey(author, date).
          document: docXml(`
            <w:p>
              <w:commentRangeStart w:id="0"/>
              <w:r><w:t>quoted</w:t></w:r>
              <w:commentRangeEnd w:id="0"/>
              <w:commentRangeStart w:id="1"/>
              <w:r><w:t>more</w:t></w:r>
              <w:commentRangeEnd w:id="1"/>
            </w:p>`),
          comments: commentsXml(`
            <w:comment w:id="0" w:author="Parent" w:date="2026-01-01T10:00:00Z">
              <w:p><w:r><w:t>parent body</w:t></w:r></w:p>
            </w:comment>
            <w:comment w:id="1" w:author="Replier" w:date="2026-01-01T11:00:00Z">
              <w:p><w:r><w:t>reply body</w:t></w:r></w:p>
            </w:comment>`),
        }),
        driveComments: [
          {
            id: "drive-parent",
            author: { displayName: "Parent" },
            createdTime: "2026-01-01T10:00:00Z",
            content: "parent body",
            replies: [
              {
                id: "drive-reply",
                author: { displayName: "Replier" },
                createdTime: "2026-01-01T11:00:00Z",
                content: "reply body",
              },
            ],
          },
        ],
      },
    });
    const r = await ingestVersionComments(h.versionId);
    expect(r.inserted).toBe(2);

    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, h.projectId));
    const parent = rows.find((r) => r.body === "parent body");
    const reply = rows.find((r) => r.body === "reply body");
    expect(parent).toBeDefined();
    expect(reply).toBeDefined();
    expect(parent!.parentCommentId).toBeNull();
    expect(reply!.parentCommentId).toBe(parent!.id);
  });
});
