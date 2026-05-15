import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { postJsonRequest } from "../../test/fetch.ts";
import { handleProjectsListPost } from "./projects-list.ts";

beforeEach(cleanDb);

const post = (opts?: { auth?: string }) =>
  postJsonRequest("/api/extension/projects", {}, opts);

describe("handleProjectsListPost", () => {
  test("401 without Authorization", async () => {
    const res = await handleProjectsListPost(post());
    expect(res.status).toBe(401);
  });

  test("returns only the caller's projects, newest-first", async () => {
    const a = await seedUser({ email: "a@example.com" });
    const b = await seedUser({ email: "b@example.com" });
    const a1 = await seedProject({ ownerUserId: a.id, parentDocId: "a1" });
    await new Promise((r) => setTimeout(r, 5));
    const a2 = await seedProject({ ownerUserId: a.id, parentDocId: "a2" });
    await seedProject({ ownerUserId: b.id, parentDocId: "b1" });

    const { token } = await issueTestSession({ userId: a.id });
    const res = await handleProjectsListPost(post({ auth: `Bearer ${token}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: { id: string; parentDocId: string }[];
    };
    expect(body.projects.map((p) => p.id)).toEqual([a2.id, a1.id]);
  });

  test("returns empty list for a user with no projects", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleProjectsListPost(post({ auth: `Bearer ${token}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
  });
});
