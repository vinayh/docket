import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedUser } from "../../test/db.ts";
import { db } from "../db/client.ts";
import { apiToken } from "../db/schema.ts";
import {
  TOKEN_PREFIX,
  issueApiToken,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
} from "./api-token.ts";

beforeEach(cleanDb);

function hashHex(plaintext: string): string {
  return new Bun.CryptoHasher("sha256").update(plaintext).digest("hex");
}

describe("issueApiToken", () => {
  test("returns a `dkt_…` plaintext and stores only the sha256 hash", async () => {
    const u = await seedUser();
    const { token, row } = await issueApiToken({ userId: u.id, label: "ci" });

    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    // 32 random bytes → 43 base64url chars after stripping padding.
    expect(token.length - TOKEN_PREFIX.length).toBe(43);

    expect(row.userId).toBe(u.id);
    expect(row.label).toBe("ci");
    expect(row.tokenHash).toBe(hashHex(token));
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenPreview.startsWith(`${TOKEN_PREFIX}…`)).toBe(true);
    // Preview ends with the last 4 chars of the plaintext token.
    expect(row.tokenPreview.endsWith(token.slice(-4))).toBe(true);
  });

  test("two issues for the same user are independent", async () => {
    const u = await seedUser();
    const a = await issueApiToken({ userId: u.id });
    const b = await issueApiToken({ userId: u.id });
    expect(a.token).not.toBe(b.token);
    expect(a.row.tokenHash).not.toBe(b.row.tokenHash);
  });
});

describe("verifyApiToken", () => {
  test("happy path returns userId + tokenId", async () => {
    const u = await seedUser();
    const { token, row } = await issueApiToken({ userId: u.id });
    const v = await verifyApiToken(token);
    expect(v).toEqual({ userId: u.id, tokenId: row.id });
  });

  test("short-circuits before the DB on a wrong prefix", async () => {
    expect(await verifyApiToken("not-a-docket-token")).toBeNull();
    expect(await verifyApiToken("")).toBeNull();
  });

  test("returns null for an unknown but well-formed token", async () => {
    expect(await verifyApiToken(`${TOKEN_PREFIX}deadbeef`)).toBeNull();
  });

  test("returns null once the token is revoked", async () => {
    const u = await seedUser();
    const { token, row } = await issueApiToken({ userId: u.id });
    await revokeApiToken(row.id);
    expect(await verifyApiToken(token)).toBeNull();
  });
});

describe("listApiTokens", () => {
  test("excludes revoked tokens and orders newest-first", async () => {
    const u = await seedUser();
    const a = await issueApiToken({ userId: u.id, label: "first" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await issueApiToken({ userId: u.id, label: "second" });
    await new Promise((r) => setTimeout(r, 5));
    const c = await issueApiToken({ userId: u.id, label: "third" });
    await revokeApiToken(b.row.id);

    const list = await listApiTokens(u.id);
    expect(list.map((t) => t.id)).toEqual([c.row.id, a.row.id]);
  });

  test("scoped to the user — other users' tokens don't leak", async () => {
    const alice = await seedUser({ email: "alice@example.com" });
    const bob = await seedUser({ email: "bob@example.com" });
    await issueApiToken({ userId: alice.id });
    const bobToken = await issueApiToken({ userId: bob.id });

    const list = await listApiTokens(bob.id);
    expect(list.map((t) => t.id)).toEqual([bobToken.row.id]);
  });
});

describe("revokeApiToken", () => {
  test("returns true on first call, false on the second (already revoked)", async () => {
    const u = await seedUser();
    const { row } = await issueApiToken({ userId: u.id });
    expect(await revokeApiToken(row.id)).toBe(true);
    expect(await revokeApiToken(row.id)).toBe(false);
  });

  test("returns false for an unknown id", async () => {
    expect(await revokeApiToken(crypto.randomUUID())).toBe(false);
  });

  test("stamps revoked_at on the row", async () => {
    const u = await seedUser();
    const { row } = await issueApiToken({ userId: u.id });
    await revokeApiToken(row.id);
    const after = await db
      .select()
      .from(apiToken)
      .where(eq(apiToken.id, row.id))
      .limit(1);
    expect(after[0]?.revokedAt).toBeInstanceOf(Date);
  });
});
