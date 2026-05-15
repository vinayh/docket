import { beforeEach, describe, expect, test } from "bun:test";
import {
  handleAuthExtLaunchTab,
  handleAuthExtSuccess,
} from "./auth-handler.tsx";
import { cleanDb, seedUser } from "../../test/db.ts";
import { issueTestSession } from "../../test/session.ts";

beforeEach(cleanDb);

const EXT_ID_OK = "a".repeat(32); // 32 lowercase a-p chars = valid Chrome ext id

describe("handleAuthExtLaunchTab", () => {
  test("missing ext param → 400", async () => {
    const req = new Request("http://localhost/api/auth/ext/launch-tab");
    const res = await handleAuthExtLaunchTab(req);
    expect(res.status).toBe(400);
  });

  test("rejects ext ids that don't match Chrome or Firefox shapes", async () => {
    const req = new Request(
      `http://localhost/api/auth/ext/launch-tab?ext=${encodeURIComponent("not-a-real-id")}`,
    );
    const res = await handleAuthExtLaunchTab(req);
    expect(res.status).toBe(400);
  });

  test("rejects ext ids with characters outside the a-p Chrome alphabet", async () => {
    // Chrome IDs are exactly 32 chars in [a-p]; 'z' is out of range.
    const bad = `${"a".repeat(31)}z`;
    const req = new Request(
      `http://localhost/api/auth/ext/launch-tab?ext=${encodeURIComponent(bad)}`,
    );
    const res = await handleAuthExtLaunchTab(req);
    expect(res.status).toBe(400);
  });
});

describe("handleAuthExtSuccess", () => {
  test("missing ext param → 400", async () => {
    const req = new Request("http://localhost/api/auth/ext/success");
    const res = await handleAuthExtSuccess(req);
    expect(res.status).toBe(400);
  });

  test("disallowed ext id → 400 before any session lookup", async () => {
    const req = new Request(
      `http://localhost/api/auth/ext/success?ext=${encodeURIComponent("https://evil.com")}`,
    );
    const res = await handleAuthExtSuccess(req);
    expect(res.status).toBe(400);
  });

  test("no session cookie → 401", async () => {
    const req = new Request(
      `http://localhost/api/auth/ext/success?ext=${encodeURIComponent(EXT_ID_OK)}`,
    );
    const res = await handleAuthExtSuccess(req);
    expect(res.status).toBe(401);
  });

  test("renders both the sendMessage bridge and the fragment fallback", async () => {
    const u = await seedUser();
    const { token } = await issueTestSession({ userId: u.id });
    const req = new Request(
      `http://localhost/api/auth/ext/success?ext=${encodeURIComponent(EXT_ID_OK)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const res = await handleAuthExtSuccess(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");

    const html = await res.text();
    // Inline JSON-encoded values, so look for the JSON.stringify shape.
    expect(html).toContain(`"${token}"`);
    expect(html).toContain(`"${EXT_ID_OK}"`);
    // Both delivery paths must be present in the one script — the page
    // chooses at runtime via `typeof chrome.runtime.sendMessage`.
    expect(html).toContain("chrome.runtime.sendMessage");
    expect(html).toContain("'auth/token'");
    expect(html).toContain("location.hash");
    expect(html).toContain("token=");
  });
});
