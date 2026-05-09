import { beforeAll, describe, expect, test } from "bun:test";
import { handleOauthCallback, handleOauthStart } from "./oauth.ts";

beforeAll(() => {
  // buildAuthUrl needs these via config.google.* — pin in case the dev's
  // local `.env` has different values.
  Bun.env.GOOGLE_CLIENT_ID = "test-client-id";
  Bun.env.GOOGLE_REDIRECT_URI = "http://localhost:8787/oauth/callback";
});

describe("/oauth/start", () => {
  test("redirects to accounts.google.com with state and offline access", () => {
    const res = handleOauthStart(new Request("http://localhost/oauth/start"));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("https://accounts.google.com/")).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toMatch(/[0-9a-f-]{36}/);
    expect(url.searchParams.get("scope") ?? "").toContain("drive.file");
  });

  test("each call mints a fresh state", () => {
    const a = new URL(handleOauthStart(new Request("http://localhost/")).headers.get("location")!);
    const b = new URL(handleOauthStart(new Request("http://localhost/")).headers.get("location")!);
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

  test("400 with a state we never issued", async () => {
    const res = await handleOauthCallback(
      new Request(
        `http://localhost/oauth/callback?code=abc&state=${crypto.randomUUID()}`,
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("invalid or expired state");
  });

  test("400 with a state that's been replayed (delete-on-use)", async () => {
    // Issue a fresh state, then "consume" it with a fake code so the second
    // call sees an absent state. We don't care that the first call also fails
    // (no Google) — just that the state Map entry is gone after one use.
    const start = handleOauthStart(new Request("http://localhost/"));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;

    // First callback consumes state, then completeOAuth fails on no fetch
    // stub. Either response is fine; what we care about is the second call.
    await handleOauthCallback(
      new Request(`http://localhost/oauth/callback?code=ignored&state=${state}`),
    ).catch(() => undefined);

    const replay = await handleOauthCallback(
      new Request(`http://localhost/oauth/callback?code=ignored&state=${state}`),
    );
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { message: string }).message).toContain(
      "invalid or expired state",
    );
  });
});
