import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanDb,
  seedProject,
  seedUser,
  seedVersion,
} from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import { driveCredential } from "../db/schema.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
import { issueApiToken } from "../auth/api-token.ts";
import { handleVersionDiffPost } from "./version-diff.ts";
import type { Document } from "../google/docs.ts";

beforeEach(cleanDb);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seedDriveCredential(userId: string): Promise<void> {
  await db.insert(driveCredential).values({
    userId,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshTokenEncrypted: await encryptWithMaster("1//rt-test"),
  });
}

function stubGoogle(byDocId: Record<string, Document>): void {
  setFetch(async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-test",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/drive.file",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const m = /docs\.googleapis\.com\/v1\/documents\/([^/?]+)/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const doc = byDocId[id];
      if (!doc) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

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
        { auth: "Bearer not-a-margin-token" },
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

  test("404 for cross-tenant — caller doesn't own the project", async () => {
    const owner = await seedUser();
    const p = await seedProject({ ownerUserId: owner.id });
    const a = await seedVersion({ projectId: p.id, createdByUserId: owner.id });
    const b = await seedVersion({ projectId: p.id, createdByUserId: owner.id });
    const other = await seedUser();
    const { token } = await issueApiToken({ userId: other.id });
    const res = await handleVersionDiffPost(
      postDiff(
        { fromVersionId: a.id, toVersionId: b.id },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(404);
  });

  test("404 for cross-project versions (probe protection)", async () => {
    const u = await seedUser();
    const pA = await seedProject({ ownerUserId: u.id });
    const pB = await seedProject({ ownerUserId: u.id });
    const va = await seedVersion({ projectId: pA.id, createdByUserId: u.id });
    const vb = await seedVersion({ projectId: pB.id, createdByUserId: u.id });
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleVersionDiffPost(
      postDiff(
        { fromVersionId: va.id, toVersionId: vb.id },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(404);
  });

  test("200 happy path: returns paragraph summaries for both sides", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const p = await seedProject({ ownerUserId: u.id });
    const from = await seedVersion({
      projectId: p.id,
      createdByUserId: u.id,
      label: "v1",
      googleDocId: "doc-from",
    });
    const to = await seedVersion({
      projectId: p.id,
      createdByUserId: u.id,
      label: "v2",
      googleDocId: "doc-to",
    });
    stubGoogle({
      "doc-from": {
        documentId: "doc-from",
        title: "v1",
        body: {
          content: [
            {
              paragraph: {
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                elements: [{ textRun: { content: "hello world\n", textStyle: {} } }],
              },
            },
          ],
        },
      },
      "doc-to": {
        documentId: "doc-to",
        title: "v2",
        body: {
          content: [
            {
              paragraph: {
                paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                elements: [{ textRun: { content: "hello there\n", textStyle: {} } }],
              },
            },
          ],
        },
      },
    });
    const { token } = await issueApiToken({ userId: u.id });
    const res = await handleVersionDiffPost(
      postDiff(
        { fromVersionId: from.id, toVersionId: to.id },
        { auth: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: { label: string; paragraphs: { plaintext: string }[] };
      to: { label: string; paragraphs: { plaintext: string }[] };
    };
    expect(body.from.label).toBe("v1");
    expect(body.from.paragraphs[0]!.plaintext).toBe("hello world");
    expect(body.to.label).toBe("v2");
    expect(body.to.paragraphs[0]!.plaintext).toBe("hello there");
  });
});
