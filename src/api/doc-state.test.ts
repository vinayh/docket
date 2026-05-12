import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { handleDocStatePost } from "./doc-state.ts";

beforeEach(cleanDb);

function postState(body: unknown, opts?: { auth?: string }): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts?.auth !== undefined) headers.set("authorization", opts.auth);
  return new Request("http://localhost/api/extension/doc-state", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleDocStatePost validation", () => {
  test("401 without bearer", async () => {
    const res = await handleDocStatePost(postState({ docId: "abc" }));
    expect(res.status).toBe(401);
  });

  test("401 with a wrong-prefix token (short-circuits before DB)", async () => {
    const res = await handleDocStatePost(
      postState({ docId: "abc" }, { auth: "Bearer not-a-margin-token" }),
    );
    expect(res.status).toBe(401);
  });

  test("400 on invalid JSON", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleDocStatePost(
      postState("not-json", { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when docId is missing or wrong type", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    expect((await handleDocStatePost(postState({}, { auth: `Bearer ${token}` }))).status).toBe(
      400,
    );
    expect(
      (
        await handleDocStatePost(
          postState({ docId: 42 }, { auth: `Bearer ${token}` }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleDocStatePost(
          postState({ docId: "" }, { auth: `Bearer ${token}` }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("handleDocStatePost lookup", () => {
  test("returns tracked:false for an unknown doc", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleDocStatePost(
      postState({ docId: "doc-nobody-owns" }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracked: boolean; docId: string };
    expect(body.tracked).toBe(false);
    expect(body.docId).toBe("doc-nobody-owns");
  });

  test("returns tracked:true with role=parent when the doc is a project's parentDocId", async () => {
    const u = await seedUser({ email: "owner@example.com" });
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-parent" });
    await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-version",
      label: "v1",
    });
    const { token } = await issueTestSession({ userId: u.id });

    const res = await handleDocStatePost(
      postState({ docId: "doc-parent" }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tracked: true;
      role: string;
      project: { id: string; ownerEmail: string | null };
      version: { id: string; label: string } | null;
      commentCount: number;
      openReviewCount: number;
    };
    expect(body.tracked).toBe(true);
    expect(body.role).toBe("parent");
    expect(body.project.id).toBe(proj.id);
    expect(body.project.ownerEmail).toBe("owner@example.com");
    expect(body.version?.label).toBe("v1");
    expect(body.commentCount).toBe(0);
    expect(body.openReviewCount).toBe(0);
  });

  test("returns tracked:true with role=version when the doc is a version's googleDocId", async () => {
    const u = await seedUser();
    const proj = await seedProject({ ownerUserId: u.id, parentDocId: "doc-parent" });
    const ver = await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-version",
    });
    const { token } = await issueTestSession({ userId: u.id });

    const res = await handleDocStatePost(
      postState({ docId: "doc-version" }, { auth: `Bearer ${token}` }),
    );
    const body = (await res.json()) as {
      tracked: true;
      role: string;
      version: { id: string };
    };
    expect(body.tracked).toBe(true);
    expect(body.role).toBe("version");
    expect(body.version.id).toBe(ver.id);
  });

  test("does not leak another user's project — returns tracked:false", async () => {
    // User A owns the project; user B asks about it. Per SPEC §8, projects
    // belong to a tenant; cross-user reads aren't authorized at this layer.
    const owner = await seedUser({ email: "a@example.com" });
    await seedProject({ ownerUserId: owner.id, parentDocId: "doc-x" });

    const other = await seedUser({ email: "b@example.com" });
    const { token } = await issueTestSession({ userId: other.id });

    const res = await handleDocStatePost(
      postState({ docId: "doc-x" }, { auth: `Bearer ${token}` }),
    );
    const body = (await res.json()) as { tracked: boolean };
    expect(body.tracked).toBe(false);
  });
});
