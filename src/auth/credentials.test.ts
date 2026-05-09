import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedUser } from "../../test/db.ts";
import { setFetch } from "../../test/fetch.ts";
import { db } from "../db/client.ts";
import { driveCredential } from "../db/schema.ts";
import { encryptWithMaster } from "./encryption.ts";
import { storeRefreshToken, tokenProviderForUser } from "./credentials.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(cleanDb);

/**
 * Stub the Google `oauth2.googleapis.com/token` POST. Returns sequential
 * access tokens "access-1", "access-2", … so tests can pin which call they
 * received. `expires_in` defaults to 3600s; the cache safety margin is 60s.
 */
function stubRefreshTokenEndpoint(opts?: { expiresIn?: number }) {
  let n = 0;
  const calls: number[] = [];
  setFetch(async (input) => {
    const url = String(input);
    if (!url.includes("oauth2.googleapis.com/token")) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    n += 1;
    calls.push(n);
    return new Response(
      JSON.stringify({
        access_token: `access-${n}`,
        expires_in: opts?.expiresIn ?? 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/drive.file",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return {
    get count() {
      return calls.length;
    },
  };
}

async function seedDriveCredential(userId: string, refreshToken = "1//rt-test") {
  await db.insert(driveCredential).values({
    userId,
    scope: "https://www.googleapis.com/auth/drive.file",
    refreshTokenEncrypted: await encryptWithMaster(refreshToken),
  });
}

describe("tokenProviderForUser", () => {
  test("first getAccessToken triggers a refresh; second is cached", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const stub = stubRefreshTokenEndpoint();

    const tp = tokenProviderForUser(u.id);
    expect(await tp.getAccessToken()).toBe("access-1");
    expect(stub.count).toBe(1);

    expect(await tp.getAccessToken()).toBe("access-1");
    expect(stub.count).toBe(1); // cached, no second network call
  });

  test("refresh is forced after the cached token's expiry margin", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    // expires_in=60s and SAFETY_MARGIN_MS=60_000 → cached token is already
    // past its expiry the moment it lands, so the next call refreshes.
    const stub = stubRefreshTokenEndpoint({ expiresIn: 60 });

    const tp = tokenProviderForUser(u.id);
    expect(await tp.getAccessToken()).toBe("access-1");
    expect(await tp.getAccessToken()).toBe("access-2");
    expect(stub.count).toBe(2);
  });

  test("concurrent getAccessToken calls share a single inflight refresh", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const stub = stubRefreshTokenEndpoint();

    const tp = tokenProviderForUser(u.id);
    const [a, b, c] = await Promise.all([
      tp.getAccessToken(),
      tp.getAccessToken(),
      tp.getAccessToken(),
    ]);
    expect([a, b, c]).toEqual(["access-1", "access-1", "access-1"]);
    expect(stub.count).toBe(1); // dedup: one refresh, three readers
  });

  test("refreshAccessToken() bypasses the cache even if it's still valid", async () => {
    const u = await seedUser();
    await seedDriveCredential(u.id);
    const stub = stubRefreshTokenEndpoint();

    const tp = tokenProviderForUser(u.id);
    expect(await tp.getAccessToken()).toBe("access-1");
    expect(await tp.refreshAccessToken()).toBe("access-2");
    expect(stub.count).toBe(2);
  });

  test("loadRefreshToken throws a useful error when no credential exists", async () => {
    const u = await seedUser();
    // Note: no seedDriveCredential — the token provider is built lazily,
    // so the error only surfaces on the first getAccessToken call.
    const tp = tokenProviderForUser(u.id);
    await expect(tp.getAccessToken()).rejects.toThrow(
      new RegExp(`no drive credential for user ${u.id}`),
    );
  });
});

describe("storeRefreshToken", () => {
  test("inserts an encrypted credential for a new user", async () => {
    const u = await seedUser();
    await storeRefreshToken({
      userId: u.id,
      refreshToken: "1//new-rt",
      scope: "https://www.googleapis.com/auth/drive.file",
    });

    const rows = await db.select().from(driveCredential);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(u.id);
    expect(rows[0]!.refreshTokenEncrypted).not.toContain("new-rt");
  });

  test("upserts: re-storing replaces the encrypted blob and bumps updatedAt", async () => {
    const u = await seedUser();
    await storeRefreshToken({
      userId: u.id,
      refreshToken: "1//first",
      scope: "scope-a",
    });
    const before = (await db.select().from(driveCredential))[0]!;

    await new Promise((r) => setTimeout(r, 5));
    await storeRefreshToken({
      userId: u.id,
      refreshToken: "1//second",
      scope: "scope-b",
    });
    const rows = await db.select().from(driveCredential);
    expect(rows).toHaveLength(1);
    const after = rows[0]!;

    expect(after.id).toBe(before.id);
    expect(after.scope).toBe("scope-b");
    expect(after.refreshTokenEncrypted).not.toBe(before.refreshTokenEncrypted);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });
});
