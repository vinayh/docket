import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { issueTestSession } from "../../test/session.ts";
import { db } from "../db/client.ts";
import { encryptWithMaster } from "../auth/encryption.ts";
import { account, project } from "../db/schema.ts";
import { handleRegisterDocPost } from "./picker-register.ts";

beforeEach(cleanDb);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/picker/register-doc", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function seedDriveCredential(userId: string): Promise<void> {
  await db.insert(account).values({
    userId,
    providerId: "google",
    accountId: `sub-${userId}`,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshToken: await encryptWithMaster("1//rt-test"),
  });
}

function stubDriveGetFile(file: {
  id: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
}): void {
  setFetch(async (input) => {
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
    if (url.includes("/drive/v3/files/")) {
      return new Response(
        JSON.stringify({
          id: file.id,
          name: file.name ?? "Picked Doc",
          mimeType: file.mimeType ?? "application/vnd.google-apps.document",
          trashed: file.trashed ?? false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("handleRegisterDocPost — auth gates", () => {
  test("401 when Authorization is missing", async () => {
    const res = await handleRegisterDocPost(jsonRequest({ docUrlOrId: "abc" }));
    expect(res.status).toBe(401);
  });

  test("401 when bearer token has the wrong prefix", async () => {
    const res = await handleRegisterDocPost(
      jsonRequest({ docUrlOrId: "abc" }, { authorization: "Bearer not-a-margin-token" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("handleRegisterDocPost — happy + 409 paths", () => {
  test("200 happy: inserts a project and returns { projectId, parentDocId }", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const { token } = await issueTestSession({ userId: u.id });
    stubDriveGetFile({ id: "picked-doc-id-0123456789zZ" });

    const res = await handleRegisterDocPost(
      jsonRequest(
        { docUrlOrId: "picked-doc-id-0123456789zZ" },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectId: string; parentDocId: string };
    expect(body.parentDocId).toBe("picked-doc-id-0123456789zZ");
    expect(typeof body.projectId).toBe("string");

    const rows = await db
      .select()
      .from(project)
      .where(eq(project.id, body.projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerUserId).toBe(u.id);
  });

  test("409 already_exists when the caller already owns a project for this doc", async () => {
    const u = await seedUser();
    const existing = await seedProject({
      ownerUserId: u.id,
      parentDocId: "dup-doc-id-0123456789zZyX",
    });
    const { token } = await issueTestSession({ userId: u.id });
    // No Drive stub on purpose — the pre-check should short-circuit before
    // hitting Drive. If it does try to fetch, we want the test to fail loudly.
    setFetch(async (input) => {
      throw new Error(`unexpected fetch: ${input}`);
    });

    const res = await handleRegisterDocPost(
      jsonRequest(
        { docUrlOrId: "dup-doc-id-0123456789zZyX" },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      projectId: string;
      parentDocId: string;
    };
    expect(body.error).toBe("already_exists");
    expect(body.projectId).toBe(existing.id);
    expect(body.parentDocId).toBe("dup-doc-id-0123456789zZyX");
  });

  test("400 when docUrlOrId is missing from the body", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleRegisterDocPost(
      jsonRequest({}, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when docUrlOrId is empty", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const res = await handleRegisterDocPost(
      jsonRequest({ docUrlOrId: "" }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(400);
  });
});
