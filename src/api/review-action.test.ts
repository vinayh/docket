import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser, seedVersion, seedReviewRequest } from "../../test/db.ts";
import { db } from "../db/client.ts";
import { reviewAssignment } from "../db/schema.ts";
import { issueReviewActionToken } from "../domain/review-action.ts";
import { handleReviewActionGet } from "./review-action.ts";

beforeEach(cleanDb);

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: "GET" });
}

async function seedAssignmentWorld() {
  const owner = await seedUser({ email: "owner@example.com" });
  const reviewer = await seedUser({ email: "reviewer@example.com" });
  const proj = await seedProject({ ownerUserId: owner.id });
  const ver = await seedVersion({
    projectId: proj.id,
    createdByUserId: owner.id,
  });
  const rr = await seedReviewRequest({
    projectId: proj.id,
    versionId: ver.id,
    createdByUserId: owner.id,
  });
  await db
    .insert(reviewAssignment)
    .values({ reviewRequestId: rr.id, userId: reviewer.id, status: "pending" });
  return { owner, reviewer, proj, ver, rr };
}

describe("handleReviewActionGet", () => {
  test("404 for an unknown token", async () => {
    const res = await handleReviewActionGet(get("/r/mra_unknown"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("404 for a path that doesn't carry a token", async () => {
    const res = await handleReviewActionGet(get("/r/"));
    expect(res.status).toBe(404);
  });

  test("mark_reviewed transitions the assignment + 404s on second click", async () => {
    const world = await seedAssignmentWorld();
    const { token } = await issueReviewActionToken({
      reviewRequestId: world.rr.id,
      assigneeUserId: world.reviewer.id,
      action: "mark_reviewed",
    });

    const first = await handleReviewActionGet(get(`/r/${token}`));
    expect(first.status).toBe(200);

    const after = await db
      .select()
      .from(reviewAssignment)
      .where(eq(reviewAssignment.userId, world.reviewer.id))
      .limit(1);
    expect(after[0]!.status).toBe("reviewed");
    expect(after[0]!.respondedAt).not.toBeNull();

    const replay = await handleReviewActionGet(get(`/r/${token}`));
    expect(replay.status).toBe(404);
  });

  test("decline marks the assignment declined", async () => {
    const world = await seedAssignmentWorld();
    const { token } = await issueReviewActionToken({
      reviewRequestId: world.rr.id,
      assigneeUserId: world.reviewer.id,
      action: "decline",
    });
    const res = await handleReviewActionGet(get(`/r/${token}`));
    expect(res.status).toBe(200);
    const after = await db
      .select()
      .from(reviewAssignment)
      .where(eq(reviewAssignment.userId, world.reviewer.id))
      .limit(1);
    expect(after[0]!.status).toBe("declined");
  });

  test("expired token returns 404", async () => {
    const world = await seedAssignmentWorld();
    const { token } = await issueReviewActionToken({
      reviewRequestId: world.rr.id,
      assigneeUserId: world.reviewer.id,
      action: "mark_reviewed",
      ttlMs: -1, // already expired
    });
    const res = await handleReviewActionGet(get(`/r/${token}`));
    expect(res.status).toBe(404);
  });
});
