import { beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedCanonicalComment,
  seedCommentProjection,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { db } from "../db/client.ts";
import { canonicalComment } from "../db/schema.ts";
import { getVersionCommentsPayload } from "./version-comments.ts";

beforeEach(cleanDb);

describe("getVersionCommentsPayload", () => {
  test("returns null when the version doesn't exist", async () => {
    const u = await seedUser();
    expect(
      await getVersionCommentsPayload({ versionId: "nope", userId: u.id }),
    ).toBeNull();
  });

  test("returns null for non-owner (no cross-tenant info leak)", async () => {
    const owner = await seedUser();
    const proj = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });
    const other = await seedUser();
    expect(
      await getVersionCommentsPayload({ versionId: v.id, userId: other.id }),
    ).toBeNull();
  });

  test("empty payload when version exists but has no projections", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v1",
    });
    const payload = await getVersionCommentsPayload({
      versionId: v.id,
      userId: u.id,
    });
    expect(payload).not.toBeNull();
    expect(payload!.versionId).toBe(v.id);
    expect(payload!.versionLabel).toBe("v1");
    expect(payload!.projectId).toBe(proj.id);
    expect(payload!.comments).toEqual([]);
  });

  test("surfaces origin-version label + projection state for each row", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const v1 = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v1",
    });
    const v2 = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v2",
      parentVersionId: v1.id,
    });
    // Comment originated on v1, was projected onto v2 with a fuzzy match.
    const cc = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: v1.id,
      body: "is this still relevant?",
      anchor: { quotedText: "the answer is 42" },
    });
    await seedCommentProjection({
      canonicalCommentId: cc.id,
      versionId: v2.id,
      projectionStatus: "fuzzy",
      anchorMatchConfidence: 72,
      googleCommentId: "google-comment-abc",
    });

    const payload = await getVersionCommentsPayload({
      versionId: v2.id,
      userId: u.id,
    });
    expect(payload!.comments).toHaveLength(1);
    const entry = payload!.comments[0]!;
    expect(entry.canonicalCommentId).toBe(cc.id);
    expect(entry.body).toBe("is this still relevant?");
    expect(entry.anchor.quotedText).toBe("the answer is 42");
    expect(entry.originVersionId).toBe(v1.id);
    expect(entry.originVersionLabel).toBe("v1");
    expect(entry.kind).toBe("comment");
    expect(entry.status).toBe("open");
    expect(entry.projection.status).toBe("fuzzy");
    expect(entry.projection.anchorMatchConfidence).toBe(72);
    expect(entry.projection.googleCommentId).toBe("google-comment-abc");
  });

  test("excludes projections from other versions in the same project", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const v1 = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v1",
    });
    const v2 = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v2",
    });
    const ccA = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: v1.id,
      body: "on v1 only",
    });
    const ccB = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: v1.id,
      body: "on both",
    });
    await seedCommentProjection({ canonicalCommentId: ccA.id, versionId: v1.id });
    await seedCommentProjection({ canonicalCommentId: ccB.id, versionId: v1.id });
    await seedCommentProjection({ canonicalCommentId: ccB.id, versionId: v2.id });

    const v2Payload = await getVersionCommentsPayload({
      versionId: v2.id,
      userId: u.id,
    });
    expect(v2Payload!.comments.map((c) => c.body)).toEqual(["on both"]);
  });

  test("orders comments by origin timestamp desc; carries reply chain via parentCanonicalCommentId", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v1",
    });

    // Insert directly so we can fix timestamps + parent_comment_id.
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-02T00:00:00Z");
    const parentRow = (
      await db
        .insert(canonicalComment)
        .values({
          projectId: proj.id,
          originVersionId: v.id,
          originTimestamp: t0,
          kind: "comment",
          anchor: { quotedText: "" },
          body: "parent",
        })
        .returning()
    )[0]!;
    const replyRow = (
      await db
        .insert(canonicalComment)
        .values({
          projectId: proj.id,
          originVersionId: v.id,
          originTimestamp: t1,
          kind: "comment",
          anchor: { quotedText: "" },
          body: "reply",
          parentCommentId: parentRow.id,
        })
        .returning()
    )[0]!;
    await seedCommentProjection({
      canonicalCommentId: parentRow.id,
      versionId: v.id,
    });
    await seedCommentProjection({
      canonicalCommentId: replyRow.id,
      versionId: v.id,
    });

    const payload = await getVersionCommentsPayload({
      versionId: v.id,
      userId: u.id,
    });
    expect(payload!.comments.map((c) => c.body)).toEqual(["reply", "parent"]);
    expect(payload!.comments[0]!.parentCanonicalCommentId).toBe(parentRow.id);
    expect(payload!.comments[1]!.parentCanonicalCommentId).toBeNull();
  });
});
