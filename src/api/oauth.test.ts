import { beforeAll, describe, expect, test } from "bun:test";
import { handleOauthCallback, handleOauthStart } from "./oauth.ts";

beforeAll(() => {
  // buildAuthUrl needs these via config.google.* — pin in case the dev's
  // local `.env` has different values.
  Bun.env.GOOGLE_CLIENT_ID = "test-client-id";
  Bun.env.GOOGLE_REDIRECT_URI = "http://localhost:8787/oauth/callback";
});

describe("/oauth/start", () => {
  test("redirects to accounts.google.com with signed state and offline access", async () => {
    const res = await handleOauthStart(new Request("http://localhost/oauth/start"));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("https://accounts.google.com/")).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    // State is now `<payloadB64>.<sigB64>`; no server-side map to consult.
    expect(url.searchParams.get("state") ?? "").toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("scope") ?? "").toContain("drive.file");
  });

  test("each call mints a fresh state", async () => {
    const a = new URL((await handleOauthStart(new Request("http://localhost/"))).headers.get("location")!);
    const b = new URL((await handleOauthStart(new Request("http://localhost/"))).headers.get("location")!);
    expect(a.searchParams.get("state")).not.toBe(b.searchParams.get("state"));
  });
});

describe("/oauth/callback validation", () => {
  test("400 when ?error=… is set", async () => {
    const res = await handleOauthCallback(
      new Request("http://localhost/oauth/callback?error=access_denied"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("access_denied");
  });

  test("400 when code or state is missing", async () => {
    expect(
      (
        await handleOauthCallback(
          new Request("http://localhost/oauth/callback?code=abc"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleOauthCallback(
          new Request("http://localhost/oauth/callback?state=abc"),
        )
      ).status,
    ).toBe(400);
  });

  test("400 with a forged state", async () => {
    // A random UUID is not a valid `<payload>.<sig>` token — HMAC verify
    // rejects it before we ever look up server-side state.
    const res = await handleOauthCallback(
      new Request(
        `http://localhost/oauth/callback?code=abc&state=${crypto.randomUUID()}`,
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("invalid or expired state");
  });

  test("400 with a tampered signature", async () => {
    // Take a freshly-issued state, flip a bit in the signature half, and
    // verify the callback rejects it. Replaces the prior "delete-on-use"
    // assertion — single-use is now enforced by Google's OAuth code, not
    // by us, so we only verify signature integrity here.
    const start = await handleOauthStart(new Request("http://localhost/"));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const dot = state.indexOf(".");
    const tampered = `${state.slice(0, dot + 1)}${state[dot + 1] === "A" ? "B" : "A"}${state.slice(dot + 2)}`;

    const res = await handleOauthCallback(
      new Request(`http://localhost/oauth/callback?code=ignored&state=${tampered}`),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "invalid or expired state",
    );
  });
});
