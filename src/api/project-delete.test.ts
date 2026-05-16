import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { postJsonRequest } from "../../test/fetch.ts";
import { handleProjectDeletePost } from "./project-delete.ts";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
import { eq } from "drizzle-orm";

beforeEach(cleanDb);

const postDelete = (body: unknown, opts?: { auth?: string }) =>
  postJsonRequest("/api/extension/project-delete", body, opts);

describe("handleProjectDeletePost validation", () => {
  test("401 without bearer", async () => {
    const res = await handleProjectDeletePost(postDelete({ projectId: "abc" }));
    expect(res.status).toBe(401);
  });

  test("400 when projectId is missing", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleProjectDeletePost(
      postDelete({}, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });
});

describe("handleProjectDeletePost auth + cascade", () => {
  test("404 when the project doesn't exist", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleProjectDeletePost(
      postDelete({ projectId: "missing" }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  test("404 for non-owner (cross-tenant isolation)", async () => {
    const owner = await seedUser({ email: "owner@example.com" });
    const intruder = await seedUser({ email: "intruder@example.com" });
    const proj = await seedProject({ ownerUserId: owner.id });
    const { token } = await issueTestSession({ userId: intruder.id });
    const res = await handleProjectDeletePost(
      postDelete({ projectId: proj.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
    // The row is untouched.
    const after = await db
      .select()
      .from(project)
      .where(eq(project.id, proj.id))
      .limit(1);
    expect(after.length).toBe(1);
  });

  test("200 + cascading delete for the owner", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const proj = await seedProject({ ownerUserId: u.id });
    await seedVersion({ projectId: proj.id, createdByUserId: u.id });
    const versionsBefore = await db
      .select()
      .from(version)
      .where(eq(version.projectId, proj.id));
    expect(versionsBefore.length).toBeGreaterThan(0);

    const res = await handleProjectDeletePost(
      postDelete({ projectId: proj.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const projAfter = await db
      .select()
      .from(project)
      .where(eq(project.id, proj.id));
    expect(projAfter.length).toBe(0);
    const versionsAfter = await db
      .select()
      .from(version)
      .where(eq(version.projectId, proj.id));
    expect(versionsAfter.length).toBe(0);
  });
});
