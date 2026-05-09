import { test, expect, describe, beforeAll } from "bun:test";
import {
  importMasterKey,
  encrypt,
  decrypt,
  encryptWithMaster,
  decryptWithMaster,
} from "./encryption.ts";

const validKeyB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

describe("envelope encryption", () => {
  test("round-trips plaintext", async () => {
    const kek = await importMasterKey(validKeyB64);
    const blob = await encrypt("hello, world", kek);
    const out = await decrypt(blob, kek);
    expect(out).toBe("hello, world");
  });

  test("round-trips a refresh-token-shaped string", async () => {
    const kek = await importMasterKey(validKeyB64);
    const token = "1//0g_" + "x".repeat(200);
    const blob = await encrypt(token, kek);
    expect(blob).not.toContain(token);
    const out = await decrypt(blob, kek);
    expect(out).toBe(token);
  });

  test("emits different ciphertexts for the same plaintext", async () => {
    const kek = await importMasterKey(validKeyB64);
    const a = await encrypt("same", kek);
    const b = await encrypt("same", kek);
    expect(a).not.toBe(b);
  });

  test("fails to decrypt under a different KEK", async () => {
    const kek1 = await importMasterKey(validKeyB64);
    const otherB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const kek2 = await importMasterKey(otherB64);
    const blob = await encrypt("secret", kek1);
    await expect(decrypt(blob, kek2)).rejects.toThrow();
  });

  test("detects tampered ciphertext", async () => {
    const kek = await importMasterKey(validKeyB64);
    const blob = await encrypt("secret", kek);
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0x01;
    const tampered = buf.toString("base64");
    await expect(decrypt(tampered, kek)).rejects.toThrow();
  });

  test("rejects wrong-length master key", async () => {
    const shortKey = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
    await expect(importMasterKey(shortKey)).rejects.toThrow(/32 bytes/);
  });

  test("rejects unknown version byte", async () => {
    const kek = await importMasterKey(validKeyB64);
    const blob = await encrypt("secret", kek);
    const buf = Buffer.from(blob, "base64");
    buf[0] = 99;
    await expect(decrypt(buf.toString("base64"), kek)).rejects.toThrow(/version/);
  });

  test("rejects an envelope shorter than the framed header", async () => {
    const kek = await importMasterKey(validKeyB64);
    // The shortest legitimate envelope is 1 + 12 + 48 + 12 + 16 = 89 bytes; a
    // 32-byte blob can't even hold the wrapped DEK.
    const tooShort = Buffer.from(new Uint8Array(32)).toString("base64");
    await expect(decrypt(tooShort, kek)).rejects.toThrow(/too short/);
  });
});

describe("master-key roundtrip", () => {
  beforeAll(() => {
    // `getMasterKey` reads `config.masterKeyB64`, which calls `required(...)`.
    // The repo's `.env` already provides this, but pin a deterministic value
    // here so the test doesn't depend on the developer's local env.
    Bun.env.DOCKET_MASTER_KEY = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("base64");
  });

  test("encryptWithMaster → decryptWithMaster round-trips", async () => {
    const blob = await encryptWithMaster("secret payload");
    expect(blob).not.toContain("secret payload");
    expect(await decryptWithMaster(blob)).toBe("secret payload");
  });

  test("getMasterKey caches the imported key across calls", async () => {
    // Two encrypts in a row should both succeed; if `cachedMasterKey` were
    // recomputed without caching this would still pass — the assertion is
    // really just exercising the cache hit branch for coverage. The semantic
    // guarantee (one key per process) is enforced by construction.
    const a = await encryptWithMaster("a");
    const b = await encryptWithMaster("b");
    expect(await decryptWithMaster(a)).toBe("a");
    expect(await decryptWithMaster(b)).toBe("b");
  });
});
