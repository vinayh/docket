import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedUser } from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import { driveCredential, user } from "../db/schema.ts";
import { decryptWithMaster } from "./encryption.ts";
import { completeOAuth } from "./connect.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(cleanDb);

beforeAll(() => {
  // exchangeCode reads these via config.google.* — pin so tests don't depend
  // on whatever the developer has in `.env`.
  Bun.env.GOOGLE_CLIENT_ID = "test-client-id";
  Bun.env.GOOGLE_CLIENT_SECRET = "test-secret";
  Bun.env.GOOGLE_REDIRECT_URI = "http://localhost:8787/oauth/callback";
});

interface FakeGoogle {
  refreshToken?: string | null;
  sub?: string;
  email?: string;
  name?: string;
}

/**
 * Stub both Google endpoints `completeOAuth` calls. Returns the recorded
 * request bodies so tests can assert "we POSTed the right grant_type" etc.
 */
function stubGoogle(opts: FakeGoogle = {}) {
  const captured: { token?: { code?: string; grant_type?: string }; userinfoAuth?: string } = {};
  setFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
      captured.token = {
        code: body.get("code") ?? undefined,
        grant_type: body.get("grant_type") ?? undefined,
      };
      return new Response(
        JSON.stringify({
          access_token: "access-1",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid email profile https://www.googleapis.com/auth/drive.file",
          // Use undefined (not null) so JSON.stringify drops the key entirely
          // — that's how Google represents the no-refresh-token case.
          refresh_token: opts.refreshToken === undefined ? "1//rt-fresh" : opts.refreshToken ?? undefined,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
      captured.userinfoAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(
        JSON.stringify({
          sub: opts.sub ?? "google-sub-123",
          email: opts.email ?? "alice@example.com",
          name: opts.name,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  return captured;
}

describe("completeOAuth", () => {
  test("inserts a new user, marks isNewUser, encrypts the refresh token at rest", async () => {
    const captured = stubGoogle({
      sub: "sub-new",
      email: "newbie@example.com",
      name: "Newbie",
    });

    const result = await completeOAuth("auth-code-xyz");
    expect(result.email).toBe("newbie@example.com");
    expect(result.isNewUser).toBe(true);
    expect(captured.token?.grant_type).toBe("authorization_code");
    expect(captured.token?.code).toBe("auth-code-xyz");
    expect(captured.userinfoAuth).toBe("Bearer access-1");

    const users = await db.select().from(user).where(eq(user.googleSubjectId, "sub-new"));
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe("newbie@example.com");
    expect(users[0]!.displayName).toBe("Newbie");
    expect(users[0]!.homeOrg).toBe("example.com");

    const creds = await db.select().from(driveCredential).where(eq(driveCredential.userId, users[0]!.id));
    expect(creds).toHaveLength(1);
    expect(creds[0]!.refreshTokenEncrypted).not.toContain("rt-fresh");
    expect(await decryptWithMaster(creds[0]!.refreshTokenEncrypted)).toBe("1//rt-fresh");
  });

  test("re-connecting an existing user updates credential, isNewUser=false", async () => {
    const existing = await seedUser({
      email: "alice@example.com",
      googleSubjectId: "sub-alice",
    });
    stubGoogle({ sub: "sub-alice", email: "alice@example.com" });

    const result = await completeOAuth("code");
    expect(result.userId).toBe(existing.id);
    expect(result.isNewUser).toBe(false);

    // No duplicate user row.
    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
  });

  test("throws a guidance message when Google omits refresh_token", async () => {
    stubGoogle({ refreshToken: null });
    await expect(completeOAuth("code")).rejects.toThrow(/refresh_token/);
  });
});
