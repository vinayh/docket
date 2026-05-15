import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser, seedVersion, seedReviewRequest } from "../../test/db.ts";
import { db } from "../db/client.ts";
import { reviewAssignment } from "../db/schema.ts";
import { issueReviewActionToken } from "../domain/review-action.ts";
import { handleReviewActionGet } from "./review-action.tsx";

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
    const res = await handleReviewActionGet(get("/r/mra_unknown?action=mark_reviewed"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("404 for a path that doesn't carry a token", async () => {
    const res = await handleReviewActionGet(get("/r/?action=mark_reviewed"));
    expect(res.status).toBe(404);
  });

  test("renders chooser page (200) when ?action= is absent", async () => {
    const world = await seedAssignmentWorld();
    const { token } = await issueReviewActionToken({
      reviewRequestId: world.rr.id,
      assigneeUserId: world.reviewer.id,
    });
    const res = await handleReviewActionGet(get(`/r/${token}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Choose a review action");
    expect(body).toContain("action=mark_reviewed");
    expect(body).toContain("action=decline");
  });

  test("renders chooser with 400 when ?action= is unrecognized", async () => {
    const world = await seedAssignmentWorld();
    const { token } = await issueReviewActionToken({
      reviewRequestId: world.rr.id,
      assigneeUserId: world.reviewer.id,
    });
    const res = await handleReviewActionGet(get(`/r/${token}?action=bogus`));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("bogus");
  });

  test("mark_reviewed transitions assignment; replay is idempotent", async () => {
    const world = await seedAssignmentWorld();
    const { token } = await issueReviewActionToken({
      reviewRequestId: world.rr.id,
      assigneeUserId: world.reviewer.id,
    });

    const first = await handleReviewActionGet(
      get(`/r/${token}?action=mark_reviewed`),
    );
    expect(first.status).toBe(200);

    const after = await db
      .select()
      .from(reviewAssignment)
      .where(eq(reviewAssignment.userId, world.reviewer.id))
      .limit(1);
    expect(after[0]!.status).toBe("reviewed");
    expect(after[0]!.respondedAt).not.toBeNull();

    // Re-click: still 200 (multi-use), assignment stays reviewed.
    const replay = await handleReviewActionGet(
      get(`/r/${token}?action=mark_reviewed`),
    );
    expect(replay.status).toBe(200);
    const stillReviewed = await db
      .select()
      .from(reviewAssignment)
      .where(eq(reviewAssignment.userId, world.reviewer.id))
      .limit(1);
    expect(stillReviewed[0]!.status).toBe("reviewed");
  });

  test("reviewer can change response by clicking a different action", async () => {
    const world = await seedAssignmentWorld();
    const { token } = await issueReviewActionToken({
      reviewRequestId: world.rr.id,
      assigneeUserId: world.reviewer.id,
    });

    await handleReviewActionGet(get(`/r/${token}?action=mark_reviewed`));
    expect(
      (
        await db
          .select()
          .from(reviewAssignment)
          .where(eq(reviewAssignment.userId, world.reviewer.id))
          .limit(1)
      )[0]!.status,
    ).toBe("reviewed");

    const flipped = await handleReviewActionGet(
      get(`/r/${token}?action=request_changes`),
    );
    expect(flipped.status).toBe(200);
    const after = await db
      .select()
      .from(reviewAssignment)
      .where(eq(reviewAssignment.userId, world.reviewer.id))
      .limit(1);
    expect(after[0]!.status).toBe("changes_requested");
  });

  test("decline marks the assignment declined", async () => {
    const world = await seedAssignmentWorld();
    const { token } = await issueReviewActionToken({
      reviewRequestId: world.rr.id,
      assigneeUserId: world.reviewer.id,
    });
    const res = await handleReviewActionGet(get(`/r/${token}?action=decline`));
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
      ttlMs: -1, // already expired
    });
    const res = await handleReviewActionGet(
      get(`/r/${token}?action=mark_reviewed`),
    );
    expect(res.status).toBe(404);
  });
});
