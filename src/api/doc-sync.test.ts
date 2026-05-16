import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedUser } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";
import { postJsonRequest } from "../../test/fetch.ts";
import { handleDocSyncPost } from "./doc-sync.ts";

/**
 * Auth + the no-version short-circuit are unit-testable without a Drive
 * stub. The full "ingest then re-fetch" success path needs a live Drive
 * token (or a fake `ingestVersionComments`) and is exercised through the
 * CLI / smoke commands.
 */

beforeEach(cleanDb);

const postSync = (body: unknown, opts?: { auth?: string }) =>
  postJsonRequest("/api/extension/doc-sync", body, opts);

describe("handleDocSyncPost", () => {
  test("401 without Authorization", async () => {
    const res = await handleDocSyncPost(postSync({ docId: "abc" }));
    expect(res.status).toBe(401);
  });

  test("401 with a wrong-prefix token", async () => {
    const res = await handleDocSyncPost(
      postSync({ docId: "abc" }, { auth: "Bearer not-a-margin-token" }),
    );
    expect(res.status).toBe(401);
  });

  test("returns tracked:false for an unknown doc without invoking ingest", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleDocSyncPost(
      postSync({ docId: "doc-not-tracked" }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracked: boolean };
    expect(body.tracked).toBe(false);
  });
});
