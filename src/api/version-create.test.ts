import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { issueTestSession } from "../../test/session.ts";
import { db } from "../db/client.ts";
import { account } from "../db/schema.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
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

const realFetch = globalThis.fetch;

describe("handleVersionCreatePost — happy path", () => {
  beforeEach(cleanDb);
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function seedDriveCredential(userId: string): Promise<void> {
    await db.insert(account).values({
      userId,
      providerId: "google",
      accountId: `sub-${userId}`,
      scope: "https://www.googleapis.com/auth/drive.file",
      refreshToken: await encryptWithMaster("1//rt-test"),
    });
  }

  function stubDriveAndDocs(newCopyId: string, parentName: string): void {
    setFetch(async (input, init) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "access-test",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (/\/drive\/v3\/files\/[^/]+\/copy/.test(url) && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name?: string };
        return new Response(
          JSON.stringify({
            id: newCopyId,
            name: body.name ?? "Untitled",
            mimeType: "application/vnd.google-apps.document",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (/\/drive\/v3\/files\/[^/?]+\?/.test(url)) {
        return new Response(
          JSON.stringify({
            id: "parent",
            name: parentName,
            mimeType: "application/vnd.google-apps.document",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (/\/drive\/v3\/files\/[^/]+\/watch/.test(url)) {
        // best-effort auto-subscribe; return a canned channel response so
        // background warnings don't pollute test output.
        return new Response(
          JSON.stringify({
            kind: "api#channel",
            id: crypto.randomUUID(),
            resourceId: "r",
            resourceUri: "u",
            expiration: String(Date.now() + 86_400_000),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("docs.googleapis.com/v1/documents/")) {
        return new Response(
          JSON.stringify({
            documentId: newCopyId,
            title: newCopyId,
            body: {
              content: [
                {
                  startIndex: 1,
                  endIndex: 7,
                  paragraph: {
                    elements: [
                      { startIndex: 1, endIndex: 7, textRun: { content: "hello\n" } },
                    ],
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  test("200 happy: returns { versionId, label, googleDocId }", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({
      ownerUserId: u.id,
      parentDocId: "parent-doc-id-0123456789zZ",
    });
    stubDriveAndDocs("copy-id-aaaaaaaaaaaaaaaaaa", "Original");
    const { token } = await issueTestSession({ userId: u.id });

    const res = await handleVersionCreatePost(
      postCreate({ projectId: p.id }, { auth: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versionId: string;
      label: string;
      googleDocId: string;
    };
    expect(typeof body.versionId).toBe("string");
    expect(body.label).toBe("v1");
    expect(body.googleDocId).toBe("copy-id-aaaaaaaaaaaaaaaaaa");
  });

  test("200 happy: explicit label is preserved in the response", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({
      ownerUserId: u.id,
      parentDocId: "parent-doc-id-bbbbbbbbbbbb",
    });
    stubDriveAndDocs("copy-id-bbbbbbbbbbbbbbbbbb", "Doc");
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleVersionCreatePost(
      postCreate(
        { projectId: p.id, label: "draft-1" },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string };
    expect(body.label).toBe("draft-1");
  });
});
