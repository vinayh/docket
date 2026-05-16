import { beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { postJsonRequest } from "../../test/fetch.ts";
import { handleProjectDetailPost } from "./project-detail.ts";

beforeEach(cleanDb);

const postDetail = (body: unknown, opts?: { auth?: string }) =>
  postJsonRequest("/api/extension/project", body, opts);

describe("handleProjectDetailPost validation", () => {
  test("401 without bearer", async () => {
    const res = await handleProjectDetailPost(postDetail({ projectId: "abc" }));
    expect(res.status).toBe(401);
  });

  test("401 with a wrong-prefix token (short-circuits before DB)", async () => {
    const res = await handleProjectDetailPost(
      postDetail({ projectId: "abc" }, { auth: "Bearer not-a-margin-token" }),
    );
    expect(res.status).toBe(401);
  });

  test("400 on invalid JSON", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleProjectDetailPost(
      postDetail("not-json", { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when projectId is missing or wrong type", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    expect(
      (await handleProjectDetailPost(postDetail({}, { auth: `Bearer ${token}` }))).status,
    ).toBe(400);
    expect(
      (
        await handleProjectDetailPost(
          postDetail({ projectId: 42 }, { auth: `Bearer ${token}` }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleProjectDetailPost(
          postDetail({ projectId: "" }, { auth: `Bearer ${token}` }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("handleProjectDetailPost lookup", () => {
  test("404 when the project doesn't exist", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleProjectDetailPost(
      postDetail({ projectId: "nope" }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  test("404 for non-owner (cross-tenant isolation)", async () => {
    const owner = await seedUser();
    const proj = await seedProject({ ownerUserId: owner.id });
    const other = await seedUser();
    const { token } = await issueTestSession({ userId: other.id });
    const res = await handleProjectDetailPost(
      postDetail({ projectId: proj.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  test("200 + payload shape for owner", async () => {
    const u = await seedUser({ email: "owner@example.com" });
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-parent" });
    await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      label: "v1",
      googleDocId: "doc-v1",
    });
    const { token } = await issueTestSession({ userId: u.id });

    const res = await handleProjectDetailPost(
      postDetail({ projectId: proj.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: { id: string; parentDocId: string; ownerEmail: string | null };
      versions: { id: string; label: string }[];
      derivatives: unknown[];
      reviewRequests: unknown[];
    };
    expect(body.project.id).toBe(proj.id);
    expect(body.project.parentDocId).toBe("doc-parent");
    expect(body.project.ownerEmail).toBe("owner@example.com");
    // main row is backfilled by ensureMainVersion and floats to the top.
    expect(body.versions.map((v) => v.label)).toEqual(["main", "v1"]);
    expect(body.derivatives).toEqual([]);
    expect(body.reviewRequests).toEqual([]);
  });
});
