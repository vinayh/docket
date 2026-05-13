import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  cleanDb,
  seedCanonicalComment,
  seedCommentProjection,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
import { account, commentProjection, type CommentAnchor } from "../db/schema.ts";
import type { Document } from "../google/docs.ts";
import { projectCommentsOntoVersion } from "./project-comments.ts";

beforeEach(cleanDb);
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

function singleParagraphDoc(text: string): Document {
  const content = text + "\n";
  return {
    documentId: "doc-x",
    title: "x",
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 1 + content.length,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: 1 + content.length,
                textRun: { content },
              },
            ],
          },
        },
      ],
    },
  };
}

function stubGoogleDoc(byDocId: Record<string, Document>): void {
  setFetch(async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-test",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const m = /docs\.googleapis\.com\/v1\/documents\/([^/?]+)/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const doc = byDocId[id];
      if (!doc) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

import { paragraphHash } from "./anchor.ts";

const HELLO_TEXT = "hello world goodbye";
const CLEAN_ANCHOR: CommentAnchor = {
  quotedText: "hello",
  paragraphHash: paragraphHash(HELLO_TEXT),
  structuralPosition: { paragraphIndex: 0, offset: 0 },
};

const ORPHAN_ANCHOR: CommentAnchor = {
  quotedText: "this text was deleted from the doc and cannot be found anywhere",
};

async function harness(opts?: { originText?: string; targetText?: string }) {
  const owner = await seedUser();
  await seedDriveCredential(owner.id);
  const proj = await seedProject({ ownerUserId: owner.id });
  const origin = await seedVersion({
    projectId: proj.id,
    createdByUserId: owner.id,
    label: "v1",
    googleDocId: "doc-origin",
  });
  const target = await seedVersion({
    projectId: proj.id,
    createdByUserId: owner.id,
    label: "v2",
    googleDocId: "doc-target",
  });
  stubGoogleDoc({
    "doc-origin": singleParagraphDoc(opts?.originText ?? HELLO_TEXT),
    "doc-target": singleParagraphDoc(opts?.targetText ?? HELLO_TEXT),
  });
  return { owner, proj, origin, target };
}

describe("projectCommentsOntoVersion", () => {
  test("skips comments that originated on this version", async () => {
    const { proj, target } = await harness();
    // Seed a canonical row whose origin IS the target.
    await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: target.id,
      body: "self",
      anchor: CLEAN_ANCHOR,
    });
    const r = await projectCommentsOntoVersion(target.id);
    expect(r.scanned).toBe(0);
    expect(r.inserted).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(0);
  });

  test("first run inserts projection rows reflecting reanchor status", async () => {
    const { proj, origin, target } = await harness();
    const cc = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: origin.id,
      anchor: CLEAN_ANCHOR,
    });
    const r = await projectCommentsOntoVersion(target.id);
    expect(r.scanned).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(0);
    expect(r.byStatus.clean).toBe(1);

    const rows = await db
      .select()
      .from(commentProjection)
      .where(
        and(
          eq(commentProjection.canonicalCommentId, cc.id),
          eq(commentProjection.versionId, target.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectionStatus).toBe("clean");
    expect(rows[0]?.anchorMatchConfidence).toBe(100);
  });

  test("re-running on an unchanged target reports unchanged for every row", async () => {
    const { proj, origin, target } = await harness();
    await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: origin.id,
      anchor: CLEAN_ANCHOR,
    });
    await projectCommentsOntoVersion(target.id);
    const r2 = await projectCommentsOntoVersion(target.id);
    expect(r2.scanned).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(1);
  });

  test("manually_resolved projections are never overwritten", async () => {
    const { proj, origin, target } = await harness();
    const cc = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: origin.id,
      anchor: CLEAN_ANCHOR,
    });
    await seedCommentProjection({
      canonicalCommentId: cc.id,
      versionId: target.id,
      projectionStatus: "manually_resolved",
      anchorMatchConfidence: 0,
    });
    const r = await projectCommentsOntoVersion(target.id);
    expect(r.unchanged).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.byStatus.manually_resolved).toBe(1);

    const rows = await db
      .select()
      .from(commentProjection)
      .where(eq(commentProjection.canonicalCommentId, cc.id));
    expect(rows[0]?.projectionStatus).toBe("manually_resolved");
    expect(rows[0]?.anchorMatchConfidence).toBe(0);
  });

  test("status drift from clean → orphaned writes an update row", async () => {
    // Origin doc still has "hello"; target doc has totally different text so
    // the orphan anchor stays orphaned. Pre-seed the projection as clean so
    // the diff path runs.
    const { proj, origin, target } = await harness({ targetText: "completely different content" });
    const cc = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: origin.id,
      anchor: ORPHAN_ANCHOR,
    });
    await seedCommentProjection({
      canonicalCommentId: cc.id,
      versionId: target.id,
      projectionStatus: "clean",
      anchorMatchConfidence: 100,
    });
    const r = await projectCommentsOntoVersion(target.id);
    expect(r.updated).toBe(1);
    expect(r.inserted).toBe(0);
    expect(r.unchanged).toBe(0);
    expect(r.byStatus.orphaned).toBe(1);

    const rows = await db
      .select()
      .from(commentProjection)
      .where(eq(commentProjection.canonicalCommentId, cc.id));
    expect(rows[0]?.projectionStatus).toBe("orphaned");
    expect(rows[0]?.anchorMatchConfidence).toBe(0);
  });

  test("details array carries one ProjectionDetail per scanned canonical row", async () => {
    const { proj, origin, target } = await harness();
    const a = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: origin.id,
      body: "a",
      anchor: CLEAN_ANCHOR,
    });
    const b = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: origin.id,
      body: "b",
      anchor: ORPHAN_ANCHOR,
    });
    const r = await projectCommentsOntoVersion(target.id);
    expect(r.details).toHaveLength(2);
    const ids = r.details.map((d) => d.canonicalComment.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});
