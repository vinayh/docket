import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { postJsonRequest } from "../../test/fetch.ts";
import { handleDocStatePost } from "./doc-state.ts";

beforeEach(cleanDb);

const postState = (body: unknown, opts?: { auth?: string }) =>
  postJsonRequest("/api/extension/doc-state", body, opts);

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

  test("returns tracked:true with role=parent when the doc is a project's parentDocId, scoped to main", async () => {
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
      version: { id: string; label: string; googleDocId: string } | null;
      commentCount: number;
      openReviewCount: number;
    };
    expect(body.tracked).toBe(true);
    expect(body.role).toBe("parent");
    expect(body.project.id).toBe(proj.id);
    expect(body.project.ownerEmail).toBe("owner@example.com");
    // ensureMainVersion backfills a "main" row pointing at parentDocId — the
    // parent-role response scopes the version + stats to that row.
    expect(body.version?.label).toBe("main");
    expect(body.version?.googleDocId).toBe("doc-parent");
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

  test("title is project.name when role=parent, version.name when role=version", async () => {
    const u = await seedUser();
    const proj = await seedProject({
      ownerUserId: u.id,
      parentDocId: "doc-parent",
      name: "My Q4 Plan",
    });
    await seedVersion({
      projectId: proj.id,
      createdByUserId: u.id,
      googleDocId: "doc-version",
      name: "[Margin v1] My Q4 Plan",
    });
    const { token } = await issueTestSession({ userId: u.id });

    const parentBody = (await (
      await handleDocStatePost(
        postState({ docId: "doc-parent" }, { auth: `Bearer ${token}` }),
      )
    ).json()) as { title: string | null; project: { name: string | null } };
    expect(parentBody.title).toBe("My Q4 Plan");
    expect(parentBody.project.name).toBe("My Q4 Plan");

    const versionBody = (await (
      await handleDocStatePost(
        postState({ docId: "doc-version" }, { auth: `Bearer ${token}` }),
      )
    ).json()) as {
      title: string | null;
      version: { name: string | null } | null;
    };
    expect(versionBody.title).toBe("[Margin v1] My Q4 Plan");
    expect(versionBody.version?.name).toBe("[Margin v1] My Q4 Plan");
  });

  test("title is null for legacy rows without a name", async () => {
    const u = await seedUser();
    await seedProject({ ownerUserId: u.id, parentDocId: "doc-legacy" });
    const { token } = await issueTestSession({ userId: u.id });
    const body = (await (
      await handleDocStatePost(
        postState({ docId: "doc-legacy" }, { auth: `Bearer ${token}` }),
      )
    ).json()) as { title: string | null };
    expect(body.title).toBeNull();
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
