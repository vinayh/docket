import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handlePickerPage } from "./picker-page.tsx";
import { cleanDb, seedUser } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";

beforeEach(cleanDb);

/**
 * The picker page is cookie-authenticated and configuration-gated. The
 * happy path (rendering the picker UI) depends on a live Google refresh
 * token attached to the user's `account` row — that's exercised by the
 * nightly live-Google integration suite. These tests cover the route's
 * gating: missing session, missing env config, and the "this is HTML"
 * shape so a refactor doesn't accidentally start returning JSON.
 */

const PICKER_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_API_KEY",
  "GOOGLE_PROJECT_NUMBER",
] as const;

type PickerKey = (typeof PICKER_KEYS)[number];
const original: Record<PickerKey, string | undefined> = {
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_API_KEY: undefined,
  GOOGLE_PROJECT_NUMBER: undefined,
};

beforeEach(() => {
  for (const k of PICKER_KEYS) {
    original[k] = Bun.env[k];
  }
});

afterEach(() => {
  for (const k of PICKER_KEYS) {
    if (original[k] === undefined) delete Bun.env[k];
    else Bun.env[k] = original[k]!;
  }
});

describe("handlePickerPage", () => {
  test("401 with HTML body when no session cookie or bearer", async () => {
    const req = new Request("http://localhost/api/picker/page");
    const res = await handlePickerPage(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("sign in");
  });

  test("500 when Picker env vars are missing even with a valid session", async () => {
    for (const k of PICKER_KEYS) delete Bun.env[k];
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const req = new Request("http://localhost/api/picker/page", {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await handlePickerPage(req);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("not configured");
  });

  test("500 when only some Picker env vars are set", async () => {
    Bun.env.GOOGLE_CLIENT_ID = "client-123";
    delete Bun.env.GOOGLE_API_KEY;
    Bun.env.GOOGLE_PROJECT_NUMBER = "proj-789";
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const req = new Request("http://localhost/api/picker/page", {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await handlePickerPage(req);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("not configured");
  });

  test("when env is set but no Google account → 500 with token-error page", async () => {
    // Fully-configured env path but the user has no `account.refreshToken`
    // row (we seed the user via `seedUser`, not via Better Auth's social
    // dance). `tokenProviderForUser` throws on read; the route maps that
    // to an explanatory 500 page rather than crashing.
    Bun.env.GOOGLE_CLIENT_ID = "client-123";
    Bun.env.GOOGLE_API_KEY = "api-456";
    Bun.env.GOOGLE_PROJECT_NUMBER = "proj-789";
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const req = new Request("http://localhost/api/picker/page", {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await handlePickerPage(req);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Could not mint a Drive access token");
  });
});
