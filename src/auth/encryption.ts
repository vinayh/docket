import { config } from "../config.ts";

// Envelope encryption layout (binary, base64-encoded for storage):
//   [1B version][12B kekIv][48B wrappedDek][12B dekIv][N+16B ciphertext]
// wrappedDek and ciphertext include their AES-GCM auth tags.

const VERSION = 1;
const KEK_IV_LEN = 12;
const DEK_LEN = 32;
const DEK_WRAPPED_LEN = DEK_LEN + 16;
const DEK_IV_LEN = 12;

export async function importMasterKey(b64: string): Promise<CryptoKey> {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== DEK_LEN) {
    throw new Error(`master key must be ${DEK_LEN} bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

let cachedMasterKey: Promise<CryptoKey> | null = null;
export function getMasterKey(): Promise<CryptoKey> {
  if (!cachedMasterKey) cachedMasterKey = importMasterKey(config.masterKeyB64);
  return cachedMasterKey;
}

export async function encrypt(plaintext: string, kek: CryptoKey): Promise<string> {
  const dekRaw = crypto.getRandomValues(new Uint8Array(DEK_LEN));
  const dek = await crypto.subtle.importKey("raw", dekRaw, "AES-GCM", false, ["encrypt"]);

  const kekIv = crypto.getRandomValues(new Uint8Array(KEK_IV_LEN));
  const wrappedDek = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: kekIv }, kek, dekRaw),
  );

  const dekIv = crypto.getRandomValues(new Uint8Array(DEK_IV_LEN));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: dekIv },
      dek,
      new TextEncoder().encode(plaintext),
    ),
  );

  const out = new Uint8Array(
    1 + KEK_IV_LEN + DEK_WRAPPED_LEN + DEK_IV_LEN + ciphertext.length,
  );
  let p = 0;
  out[p] = VERSION;
  p += 1;
  out.set(kekIv, p);
  p += KEK_IV_LEN;
  out.set(wrappedDek, p);
  p += DEK_WRAPPED_LEN;
  out.set(dekIv, p);
  p += DEK_IV_LEN;
  out.set(ciphertext, p);

  return Buffer.from(out).toString("base64");
}

export async function decrypt(blob: string, kek: CryptoKey): Promise<string> {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < 1 + KEK_IV_LEN + DEK_WRAPPED_LEN + DEK_IV_LEN + 16) {
    throw new Error("envelope too short");
  }
  if (buf[0] !== VERSION) {
    throw new Error(`unknown envelope version: ${buf[0]}`);
  }

  let p = 1;
  const kekIv = buf.subarray(p, p + KEK_IV_LEN);
  p += KEK_IV_LEN;
  const wrappedDek = buf.subarray(p, p + DEK_WRAPPED_LEN);
  p += DEK_WRAPPED_LEN;
  const dekIv = buf.subarray(p, p + DEK_IV_LEN);
  p += DEK_IV_LEN;
  const ciphertext = buf.subarray(p);

  const dekRaw = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: kekIv }, kek, wrappedDek),
  );
  const dek = await crypto.subtle.importKey("raw", dekRaw, "AES-GCM", false, ["decrypt"]);
  const plaintextBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: dekIv },
    dek,
    ciphertext,
  );
  return new TextDecoder().decode(plaintextBytes);
}

export async function encryptWithMaster(plaintext: string): Promise<string> {
  return encrypt(plaintext, await getMasterKey());
}

export async function decryptWithMaster(blob: string): Promise<string> {
  return decrypt(blob, await getMasterKey());
}
