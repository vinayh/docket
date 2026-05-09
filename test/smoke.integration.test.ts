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
 */
describe("smoke (live Google)", () => {
  integrationTest("refresh_token grants an access token", async () => {
    const { refreshAccessToken } = await import("../src/google/oauth.ts");
    const r = await refreshAccessToken(Bun.env.GOOGLE_CI_REFRESH_TOKEN!);
    expect(r.access_token.length).toBeGreaterThan(0);
    expect(r.token_type).toBe("Bearer");
    expect(r.expires_in).toBeGreaterThan(0);
  });
});
