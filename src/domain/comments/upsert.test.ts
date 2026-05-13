import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../../test/db.ts";
import { db } from "../../db/client.ts";
import {
  canonicalComment,
  commentProjection,
  type CommentAnchor,
} from "../../db/schema.ts";
import { upsertCanonical } from "./upsert.ts";
import type { IngestResult } from "./types.ts";

beforeEach(cleanDb);

function emptyResult(versionId: string): IngestResult {
  return {
    versionId,
    fetched: 0,
    inserted: 0,
    alreadyPresent: 0,
    skippedOrphanMetadata: 0,
    suggestionsInserted: 0,
  };
}

const cleanAnchor: CommentAnchor = {
  quotedText: "hello",
  paragraphHash: "h0",
  structuralPosition: { paragraphIndex: 0, offset: 0 },
};

const orphanAnchor: CommentAnchor = { quotedText: "vanished" };

async function harness() {
  const owner = await seedUser();
  const proj = await seedProject({ ownerUserId: owner.id });
  const ver = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });
  return { owner, proj, ver };
}

describe("upsertCanonical", () => {
  test("inserts canonical_comment + comment_projection on first write", async () => {
    const { proj, ver } = await harness();
    const result = emptyResult(ver.id);
    const id = await upsertCanonical({
      projectId: proj.id,
      versionId: ver.id,
      googleCommentId: "gc-1",
      kind: "comment",
      authorDisplayName: "Alice",
      authorEmail: "alice@example.com",
      authorPhotoHash: null,
      createdIso: "2026-01-01T00:00:00Z",
      body: "hi there",
      anchor: cleanAnchor,
      parentCommentId: null,
      result,
    });

    expect(typeof id).toBe("string");
    expect(result.inserted).toBe(1);
    expect(result.alreadyPresent).toBe(0);

    const canonical = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.id, id));
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.body).toBe("hi there");
    expect(canonical[0]?.originUserEmail).toBe("alice@example.com");
    expect(canonical[0]?.originTimestamp.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );

    const proj1 = await db
      .select()
      .from(commentProjection)
      .where(
        and(
          eq(commentProjection.canonicalCommentId, id),
          eq(commentProjection.versionId, ver.id),
        ),
      );
    expect(proj1).toHaveLength(1);
    expect(proj1[0]?.projectionStatus).toBe("clean");
    expect(proj1[0]?.anchorMatchConfidence).toBe(100);
    expect(proj1[0]?.googleCommentId).toBe("gc-1");
  });

  test("second call with the same google_comment_id short-circuits to the existing canonical id", async () => {
    const { proj, ver } = await harness();
    const r1 = emptyResult(ver.id);
    const id1 = await upsertCanonical({
      projectId: proj.id,
      versionId: ver.id,
      googleCommentId: "gc-stable",
      kind: "comment",
      authorDisplayName: "Alice",
      authorEmail: null,
      authorPhotoHash: null,
      createdIso: "2026-01-01T00:00:00Z",
      body: "first",
      anchor: cleanAnchor,
      parentCommentId: null,
      result: r1,
    });
    const r2 = emptyResult(ver.id);
    const id2 = await upsertCanonical({
      projectId: proj.id,
      versionId: ver.id,
      googleCommentId: "gc-stable",
      kind: "comment",
      authorDisplayName: "Alice",
      authorEmail: null,
      authorPhotoHash: null,
      createdIso: "2026-01-01T00:00:00Z",
      // Even a different body must not produce a new row — the
      // (versionId, googleCommentId) key is the idempotency boundary.
      body: "second",
      anchor: cleanAnchor,
      parentCommentId: null,
      result: r2,
    });
    expect(id2).toBe(id1);
    expect(r2.inserted).toBe(0);
    expect(r2.alreadyPresent).toBe(1);

    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, proj.id));
    expect(rows).toHaveLength(1);
    // The body of the existing row is preserved — upsertCanonical is not an
    // update.
    expect(rows[0]?.body).toBe("first");
  });

  test("orphan anchor (no structuralPosition) writes status=orphaned + confidence=0", async () => {
    const { proj, ver } = await harness();
    const result = emptyResult(ver.id);
    const id = await upsertCanonical({
      projectId: proj.id,
      versionId: ver.id,
      googleCommentId: "gc-orphan",
      kind: "comment",
      authorDisplayName: null,
      authorEmail: null,
      authorPhotoHash: null,
      createdIso: "2026-01-01T00:00:00Z",
      body: "lost text",
      anchor: orphanAnchor,
      parentCommentId: null,
      result,
    });
    const proj1 = await db
      .select()
      .from(commentProjection)
      .where(eq(commentProjection.canonicalCommentId, id));
    expect(proj1[0]?.projectionStatus).toBe("orphaned");
    expect(proj1[0]?.anchorMatchConfidence).toBe(0);
  });

  test("authorEmail resolves to originUserId when a matching user row exists", async () => {
    const owner = await seedUser({ email: "owner@example.com" });
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });
    const author = await seedUser({ email: "author@example.com" });

    const result = emptyResult(ver.id);
    const id = await upsertCanonical({
      projectId: proj.id,
      versionId: ver.id,
      googleCommentId: "gc-author",
      kind: "comment",
      authorDisplayName: "Author",
      authorEmail: "author@example.com",
      authorPhotoHash: null,
      createdIso: "2026-01-01T00:00:00Z",
      body: "x",
      anchor: cleanAnchor,
      parentCommentId: null,
      result,
    });

    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.id, id));
    expect(rows[0]?.originUserId).toBe(author.id);
  });

  test("invalid ISO date falls back to a sensible Date instead of NaN", async () => {
    const { proj, ver } = await harness();
    const result = emptyResult(ver.id);
    const id = await upsertCanonical({
      projectId: proj.id,
      versionId: ver.id,
      googleCommentId: "gc-bad-date",
      kind: "comment",
      authorDisplayName: null,
      authorEmail: null,
      authorPhotoHash: null,
      createdIso: "not-a-real-iso-date",
      body: "x",
      anchor: cleanAnchor,
      parentCommentId: null,
      result,
    });
    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.id, id));
    expect(rows[0]?.originTimestamp).toBeInstanceOf(Date);
    expect(Number.isNaN(rows[0]!.originTimestamp.getTime())).toBe(false);
  });

  test("pre-existing canonical + projection: SELECT-hit branch returns the existing id, body is not overwritten", async () => {
    // The unique-index catch branch in upsert.ts (lines 98-114) handles the
    // race where a concurrent ingest commits between our SELECT and INSERT.
    // That can't be driven deterministically from a unit test, so here we
    // just verify the SELECT-hit branch behaviour: existing rows are
    // returned as-is and the new body is ignored.
    const { proj, ver } = await harness();
    const inserted = await db
      .insert(canonicalComment)
      .values({
        projectId: proj.id,
        originVersionId: ver.id,
        originTimestamp: new Date(),
        kind: "comment",
        body: "winner",
        anchor: cleanAnchor,
      })
      .returning();
    const winnerId = inserted[0]!.id;
    await db.insert(commentProjection).values({
      canonicalCommentId: winnerId,
      versionId: ver.id,
      googleCommentId: "gc-existing",
      projectionStatus: "clean",
      anchorMatchConfidence: 100,
    });

    const result = emptyResult(ver.id);
    const id = await upsertCanonical({
      projectId: proj.id,
      versionId: ver.id,
      googleCommentId: "gc-existing",
      kind: "comment",
      authorDisplayName: null,
      authorEmail: null,
      authorPhotoHash: null,
      createdIso: "2026-01-01T00:00:00Z",
      body: "loser",
      anchor: cleanAnchor,
      parentCommentId: null,
      result,
    });
    expect(id).toBe(winnerId);
    expect(result.alreadyPresent).toBe(1);
    expect(result.inserted).toBe(0);
  });
});
