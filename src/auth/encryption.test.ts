import { test, expect, describe } from "bun:test";
import { importMasterKey, encrypt, decrypt } from "./encryption.ts";

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
});
