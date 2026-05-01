import { test, expect, describe, beforeAll } from "bun:test";

beforeAll(() => {
  Bun.env.GOOGLE_CLIENT_ID = "test-client-id";
  Bun.env.GOOGLE_CLIENT_SECRET = "test-secret";
  Bun.env.GOOGLE_REDIRECT_URI = "http://localhost:8787/oauth/callback";
});

const { buildAuthUrl, DRIVE_SCOPES, IDENTITY_SCOPES } = await import("./oauth.ts");

describe("buildAuthUrl", () => {
  test("includes required parameters", () => {
    const url = new URL(
      buildAuthUrl({
        scopes: [...IDENTITY_SCOPES, DRIVE_SCOPES.drive_file],
        state: "abc123",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("test-client-id");
    expect(p.get("redirect_uri")).toBe("http://localhost:8787/oauth/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("state")).toBe("abc123");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("scope")).toBe(
      "openid email profile https://www.googleapis.com/auth/drive.file",
    );
  });

  test("respects custom prompt and login_hint", () => {
    const url = new URL(
      buildAuthUrl({
        scopes: ["openid"],
        state: "s",
        prompt: "select_account",
        loginHint: "alice@example.com",
      }),
    );
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("login_hint")).toBe("alice@example.com");
  });

  test("respects per-call redirectUri override", () => {
    const url = new URL(
      buildAuthUrl({
        scopes: ["openid"],
        state: "s",
        redirectUri: "https://example.com/cb",
      }),
    );
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
  });
});
