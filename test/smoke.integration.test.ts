import { describe, expect } from "bun:test";
import { integrationTest } from "./integration.ts";

/**
 * Smoke test: prove the OAuth refresh round-trip works with real credentials.
 * If this passes, the full Drive/Docs surface is reachable; if it fails,
 * everything else is going to fail the same way and there's no point running
 * the heavier integration cases.
 *
 * Real integration coverage (project create / version create / comments
 * ingest / overlay apply / watcher subscribe-renew) lands in follow-up PRs
 * once a dedicated test Google account + cleanup helpers are in place.
 *
 * Exercises the refresh path indirectly through `tokenProviderForUser`'s
 * cache miss → `refresh` → access token branch. (The refresh helper itself
 * lives privately in `src/auth/credentials.ts`.)
 */
describe("smoke (live Google)", () => {
  integrationTest("refresh_token grants an access token", async () => {
    const refreshToken = Bun.env.GOOGLE_CI_REFRESH_TOKEN!;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Bun.env.GOOGLE_CLIENT_ID!,
        client_secret: Bun.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    expect(res.ok).toBe(true);
    const r = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(r.access_token.length).toBeGreaterThan(0);
    expect(r.token_type).toBe("Bearer");
    expect(r.expires_in).toBeGreaterThan(0);
  });
});
