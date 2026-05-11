import { beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedCanonicalComment,
  seedCommentProjection,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { issueApiToken } from "../auth/api-token.ts";
import { handleVersionCommentsPost } from "./version-comments.ts";

beforeEach(cleanDb);

function postVersionComments(body: unknown, opts?: { auth?: string }): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts?.auth !== undefined) headers.set("authorization", opts.auth);
  return new Request("http://localhost/api/extension/version-comments", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleVersionCommentsPost validation", () => {
  test("401 without bearer", async () => {
    const res = await handleVersionCommentsPost(
      postVersionComments({ versionId: "v" }),
    );
    expect(res.status).toBe(401);
  });

  test("401 with a wrong-prefix token (short-circuits before DB)", async () => {
    const res = await handleVersionCommentsPost(
      postVersionComments({ versionId: "v" }, { auth: "Bearer not-a-docket-token" }),
    );
    expect(res.status).toBe(401);
  });

  test("400 on invalid JSON", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleVersionCommentsPost(
      postVersionComments("not-json", { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when versionId is missing, wrong type, or empty", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const cases: unknown[] = [{}, { versionId: 1 }, { versionId: "" }];
    for (const body of cases) {
      const res = await handleVersionCommentsPost(
        postVersionComments(body, { auth: `Bearer ${token}` }),
      );
      expect(res.status).toBe(400);
    }
  });
});

describe("handleVersionCommentsPost lookup", () => {
  test("404 when the version doesn't exist", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleVersionCommentsPost(
      postVersionComments({ versionId: "nope" }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  test("404 for non-owner (cross-tenant isolation)", async () => {
    const owner = await seedUser();
    const proj = await seedProject({ ownerUserId: owner.id });
    const v = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });
    const other = await seedUser();
    const { token } = await issueApiToken({ userId: other.id });
    const res = await handleVersionCommentsPost(
      postVersionComments({ versionId: v.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  test("200 + payload shape for owner with one fuzzy projection", async () => {
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
    const cc = await seedCanonicalComment({
      projectId: proj.id,
      originVersionId: v1.id,
      body: "needs another look",
    });
    await seedCommentProjection({
      canonicalCommentId: cc.id,
      versionId: v2.id,
      projectionStatus: "fuzzy",
      anchorMatchConfidence: 65,
    });
    const { token } = await issueApiToken({ userId: u.id });

    const res = await handleVersionCommentsPost(
      postVersionComments({ versionId: v2.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versionId: string;
      versionLabel: string;
      projectId: string;
      comments: {
        canonicalCommentId: string;
        body: string;
        originVersionLabel: string;
        projection: { status: string; anchorMatchConfidence: number | null };
      }[];
    };
    expect(body.versionId).toBe(v2.id);
    expect(body.versionLabel).toBe("v2");
    expect(body.projectId).toBe(proj.id);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]!.canonicalCommentId).toBe(cc.id);
    expect(body.comments[0]!.body).toBe("needs another look");
    expect(body.comments[0]!.originVersionLabel).toBe("v1");
    expect(body.comments[0]!.projection.status).toBe("fuzzy");
    expect(body.comments[0]!.projection.anchorMatchConfidence).toBe(65);
  });

  test("200 with empty comments list when the version has no projections", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id });
    const v = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v1",
    });
    const { token } = await issueApiToken({ userId: u.id });

    const res = await handleVersionCommentsPost(
      postVersionComments({ versionId: v.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: unknown[] };
    expect(body.comments).toEqual([]);
  });
});
