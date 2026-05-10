import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedUser } from "../../test/db.ts";
import { issueApiToken } from "../auth/api-token.ts";
import { handleVersionDiffPost } from "./version-diff.ts";

beforeEach(cleanDb);

function postDiff(body: unknown, opts?: { auth?: string }): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts?.auth !== undefined) headers.set("authorization", opts.auth);
  return new Request("http://localhost/api/extension/version-diff", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleVersionDiffPost validation", () => {
  test("401 without bearer", async () => {
    const res = await handleVersionDiffPost(
      postDiff({ fromVersionId: "a", toVersionId: "b" }),
    );
    expect(res.status).toBe(401);
  });

  test("401 with a wrong-prefix token (short-circuits before DB)", async () => {
    const res = await handleVersionDiffPost(
      postDiff(
        { fromVersionId: "a", toVersionId: "b" },
        { auth: "Bearer not-a-docket-token" },
      ),
    );
    expect(res.status).toBe(401);
  });

  test("400 on invalid JSON", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleVersionDiffPost(
      postDiff("not-json", { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when ids are missing, wrong type, or equal", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const cases: unknown[] = [
      {},
      { fromVersionId: "a" },
      { toVersionId: "b" },
      { fromVersionId: 1, toVersionId: "b" },
      { fromVersionId: "a", toVersionId: 2 },
      { fromVersionId: "", toVersionId: "b" },
      { fromVersionId: "same", toVersionId: "same" },
    ];
    for (const body of cases) {
      const res = await handleVersionDiffPost(
        postDiff(body, { auth: `Bearer ${token}` }),
      );
      expect(res.status).toBe(400);
    }
  });

  test("404 when versions don't exist (not-owner / unknown)", async () => {
    const u = await seedUser();
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleVersionDiffPost(
      postDiff(
        { fromVersionId: "nope-a", toVersionId: "nope-b" },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(404);
  });
});
