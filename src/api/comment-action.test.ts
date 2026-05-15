import { beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedCanonicalComment,
  seedCommentProjection,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { postJsonRequest } from "../../test/fetch.ts";
import { handleCommentActionPost } from "./comment-action.ts";
import { db } from "../db/client.ts";
import { canonicalComment, commentProjection } from "../db/schema.ts";
import { eq } from "drizzle-orm";

beforeEach(cleanDb);

const post = (body: unknown, opts?: { auth?: string }) =>
  postJsonRequest("/api/extension/comment-action", body, opts);

async function seedActionWorld() {
  const owner = await seedUser({ email: "owner@example.com" });
  const proj = await seedProject({ ownerUserId: owner.id });
  const ver = await seedVersion({
    projectId: proj.id,
    createdByUserId: owner.id,
  });
  const cc = await seedCanonicalComment({
    projectId: proj.id,
    originVersionId: ver.id,
    anchor: {
      quotedText: "hello",
      structuralPosition: { paragraphIndex: 0, offset: 0 },
    },
  });
  await seedCommentProjection({
    canonicalCommentId: cc.id,
    versionId: ver.id,
    projectionStatus: "fuzzy",
    anchorMatchConfidence: 60,
  });
  const { token } = await issueTestSession({ userId: owner.id });
  return { owner, proj, ver, cc, token };
}

describe("handleCommentActionPost", () => {
  test("401 without bearer", async () => {
    const res = await handleCommentActionPost(
      post({ canonicalCommentId: "x", action: "reopen" }),
    );
    expect(res.status).toBe(401);
  });

  test("400 on bad action", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleCommentActionPost(
      post(
        { canonicalCommentId: "x", action: "nope" },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(400);
  });

  test("404 for a comment not owned by caller", async () => {
    const { cc } = await seedActionWorld();
    const stranger = await seedUser({ email: "b@example.com" });
    const { token } = await issueTestSession({ userId: stranger.id });
    const res = await handleCommentActionPost(
      post(
        { canonicalCommentId: cc.id, action: "mark_resolved" },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(404);
  });

  test("mark_resolved updates canonical_comment.status + writes audit log", async () => {
    const { cc, token } = await seedActionWorld();
    const res = await handleCommentActionPost(
      post(
        { canonicalCommentId: cc.id, action: "mark_resolved" },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("addressed");

    const fresh = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.id, cc.id))
      .limit(1);
    expect(fresh[0]!.status).toBe("addressed");
  });

  test("accept_projection sets projection status to manually_resolved", async () => {
    const { cc, ver, token } = await seedActionWorld();
    const res = await handleCommentActionPost(
      post(
        {
          canonicalCommentId: cc.id,
          action: "accept_projection",
          targetVersionId: ver.id,
        },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const fresh = await db
      .select()
      .from(commentProjection)
      .where(eq(commentProjection.canonicalCommentId, cc.id))
      .limit(1);
    expect(fresh[0]!.projectionStatus).toBe("manually_resolved");
    expect(fresh[0]!.anchorMatchConfidence).toBe(100);
  });

  test("accept_projection 400 without targetVersionId", async () => {
    const { cc, token } = await seedActionWorld();
    const res = await handleCommentActionPost(
      post(
        { canonicalCommentId: cc.id, action: "accept_projection" },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(400);
  });
});
