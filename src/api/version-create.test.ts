import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { handleVersionCreatePost } from "./version-create.ts";

/**
 * Auth + ownership are unit-testable without a Drive stub. The Drive
 * round-trip (`files.copy` + `documents.get`) is exercised through the CLI /
 * smoke commands.
 */

beforeEach(cleanDb);

function postCreate(body: unknown, opts?: { auth?: string }): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts?.auth !== undefined) headers.set("authorization", opts.auth);
  return new Request("http://localhost/api/extension/version/create", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleVersionCreatePost", () => {
  test("401 without Authorization", async () => {
    const res = await handleVersionCreatePost(postCreate({ projectId: "x" }));
    expect(res.status).toBe(401);
  });

  test("400 on missing projectId", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleVersionCreatePost(
      postCreate({}, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });

  test("404 for an unowned project", async () => {
    const owner = await seedUser({ email: "owner@example.com" });
    const proj = await seedProject({ ownerUserId: owner.id });
    const stranger = await seedUser({ email: "stranger@example.com" });
    const { token } = await issueTestSession({ userId: stranger.id });
    const res = await handleVersionCreatePost(
      postCreate({ projectId: proj.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  test("404 for an unknown project (no info leak)", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleVersionCreatePost(
      postCreate({ projectId: "no-such-project" }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  test("400 when projectId is the wrong type", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleVersionCreatePost(
      postCreate({ projectId: 123 }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when label exceeds the 64-char cap", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleVersionCreatePost(
      postCreate(
        { projectId: "p", label: "x".repeat(65) },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(400);
  });

  test("400 when label is an empty string (minLength=1)", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleVersionCreatePost(
      postCreate(
        { projectId: "p", label: "" },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(400);
  });

  test("400 on a body that isn't a JSON object", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleVersionCreatePost(
      postCreate("[]", { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });
});
