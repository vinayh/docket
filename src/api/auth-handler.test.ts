import { beforeEach, describe, expect, test } from "bun:test";
import { handleAuthExtFinalize } from "./auth-handler.ts";
import { cleanDb, seedUser } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";

beforeEach(cleanDb);

const CALLBACK_OK = `https://${"a".repeat(32)}.chromiumapp.org/`;

describe("handleAuthExtFinalize", () => {
  test("rejects callbacks that don't match the allow-list", async () => {
    const req = new Request(
      `http://localhost/api/auth/ext/finalize?cb=${encodeURIComponent("https://evil.com/")}`,
    );
    const res = await handleAuthExtFinalize(req);
    expect(res.status).toBe(400);
  });

  test("missing cb param → 400", async () => {
    const req = new Request("http://localhost/api/auth/ext/finalize");
    const res = await handleAuthExtFinalize(req);
    expect(res.status).toBe(400);
  });

  test("with no session cookie → 401 (Better Auth produced no session)", async () => {
    const req = new Request(
      `http://localhost/api/auth/ext/finalize?cb=${encodeURIComponent(CALLBACK_OK)}`,
    );
    const res = await handleAuthExtFinalize(req);
    expect(res.status).toBe(401);
  });

  test("emits the session token as a URL fragment, not a query param", async () => {
    // We can't drive Better Auth's getSession with a faked cookie cheaply,
    // so this test goes through the bearer plugin instead: Better Auth
    // accepts `Authorization: Bearer <session.token>` and resolves the
    // same `{ user, session }` shape. The finalize handler doesn't care
    // which transport delivered the session — it only reads the resolved
    // session id back to fetch the raw token row.
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });

    const req = new Request(
      `http://localhost/api/auth/ext/finalize?cb=${encodeURIComponent(CALLBACK_OK)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const res = await handleAuthExtFinalize(req);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    // Token must live in the fragment, never the query string.
    expect(url.searchParams.get("token")).toBeNull();
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const params = new URLSearchParams(hash);
    expect(params.get("token")).toBe(token);
  });
});
