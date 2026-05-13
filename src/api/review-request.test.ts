import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { handleReviewRequestPost } from "./review-request.ts";

beforeEach(cleanDb);

function post(body: unknown, opts?: { auth?: string }): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts?.auth !== undefined) headers.set("authorization", opts.auth);
  return new Request("http://localhost/api/extension/review/request", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleReviewRequestPost", () => {
  test("401 without Authorization", async () => {
    const res = await handleReviewRequestPost(
      post({ versionId: "x", assigneeEmails: ["a@b.com"] }),
    );
    expect(res.status).toBe(401);
  });

  test("400 on malformed assigneeEmails", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleReviewRequestPost(
      post(
        { versionId: "x", assigneeEmails: ["not-an-email"] },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(400);
  });

  test("400 on empty assigneeEmails", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleReviewRequestPost(
      post(
        { versionId: "x", assigneeEmails: [] },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(400);
  });

  test("404 for an unowned version", async () => {
    const owner = await seedUser({ email: "owner@example.com" });
    const proj = await seedProject({ ownerUserId: owner.id });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: owner.id,
    });
    const stranger = await seedUser({ email: "x@example.com" });
    const { token } = await issueTestSession({ userId: stranger.id });
    const res = await handleReviewRequestPost(
      post(
        { versionId: ver.id, assigneeEmails: ["bob@example.com"] },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(404);
  });
});
