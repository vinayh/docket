import { describe, expect, test } from "bun:test";
import { encryptAccountRefreshToken } from "./server.ts";
import { decryptWithMaster } from "./encryption.ts";

/**
 * The `databaseHooks.account.{create,update}.before` hook is the one piece
 * of code keeping plaintext Google refresh tokens off disk. Cover it
 * directly — Better Auth's social-callback path is upstream-tested, but
 * the encryption transform on the way in is *our* code.
 */
describe("encryptAccountRefreshToken", () => {
  test("plaintext refresh token in → encrypted blob out that decrypts back to plaintext", async () => {
    const input = {
      providerId: "google",
      accountId: "abc",
      refreshToken: "1//0aBcDeFgHiJkLmN_plaintext_refresh",
    };
    const { data } = await encryptAccountRefreshToken(input);

    // Never store the plaintext.
    expect(data.refreshToken).not.toBe(input.refreshToken);
    // The blob is non-trivially longer than the input thanks to the IV +
    // wrapped DEK + GCM auth tag overhead — a sanity check that we didn't
    // accidentally pass through.
    expect(data.refreshToken!.length).toBeGreaterThan(input.refreshToken.length);
    // And the master key can recover the original.
    expect(await decryptWithMaster(data.refreshToken!)).toBe(input.refreshToken);
    // Other fields pass through untouched.
    expect(data.providerId).toBe("google");
    expect(data.accountId).toBe("abc");
  });

  test("each call produces a distinct ciphertext for the same plaintext", async () => {
    // AES-GCM with a random IV → ciphertext must differ across runs even
    // when the plaintext is identical. Catches an accidental nonce reuse
    // (catastrophic for AES-GCM).
    const input = { refreshToken: "same-plaintext" };
    const a = (await encryptAccountRefreshToken(input)).data.refreshToken!;
    const b = (await encryptAccountRefreshToken(input)).data.refreshToken!;
    expect(a).not.toBe(b);
    expect(await decryptWithMaster(a)).toBe("same-plaintext");
    expect(await decryptWithMaster(b)).toBe("same-plaintext");
  });

  test("missing refreshToken → passes through without touching encryption", async () => {
    // Better Auth fires the hook on every account create/update, not just
    // ones carrying a refresh token. A no-op return must be a no-op — not
    // an encrypted empty string.
    const { data } = await encryptAccountRefreshToken({ providerId: "google" } as {
      providerId: string;
      refreshToken?: string | null;
    });
    expect(data).toEqual({ providerId: "google" });
  });

  test("empty-string refreshToken → passes through (treated as 'not set')", async () => {
    // Better Auth normalizes a cleared field to "" rather than dropping it.
    // We must not encrypt the empty string — that would store a non-empty
    // ciphertext that the read-side helpfully decrypts back to "".
    const { data } = await encryptAccountRefreshToken({
      providerId: "google",
      refreshToken: "",
    } as { providerId: string; refreshToken: string });
    expect(data.refreshToken).toBe("");
  });

  test("null refreshToken → passes through unchanged", async () => {
    // Drizzle hands the hook `null` when the column was explicitly nulled
    // (vs. `undefined` when it was absent from the patch). Both must
    // short-circuit; encrypting `null` would crash `crypto.subtle.encrypt`.
    const { data } = await encryptAccountRefreshToken({
      providerId: "google",
      refreshToken: null,
    } as { providerId: string; refreshToken: string | null });
    expect(data.refreshToken).toBeNull();
  });
});
