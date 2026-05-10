import { describe, expect, test } from "bun:test";
import { handleDocSyncPost } from "./doc-sync.ts";

/**
 * Format-level paths only: the auth check fires before the DB lookup, and
 * `readDocId` validates the body before hitting domain code. The success
 * path requires a live Drive token, which the unit test environment
 * doesn't have — that's exercised through the CLI / smoke commands.
 */

function postSync(body: unknown, opts?: { auth?: string }): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts?.auth !== undefined) headers.set("authorization", opts.auth);
  return new Request("http://localhost/api/extension/doc-sync", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleDocSyncPost", () => {
  test("401 without Authorization", async () => {
    const res = await handleDocSyncPost(postSync({ docId: "abc" }));
    expect(res.status).toBe(401);
  });

  test("401 with a wrong-prefix token", async () => {
    const res = await handleDocSyncPost(
      postSync({ docId: "abc" }, { auth: "Bearer not-a-docket-token" }),
    );
    expect(res.status).toBe(401);
  });
});
