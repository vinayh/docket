import { buildAuthUrl, DRIVE_SCOPES, IDENTITY_SCOPES } from "../google/oauth.ts";
import { completeOAuth } from "../auth/connect.ts";
import { config } from "../config.ts";
import { badRequest, internalError } from "./middleware.ts";

/**
 * OAuth state is a self-signed HMAC token (`<payload>.<sig>` where payload is
 * base64url(JSON{ n, exp })). The signature uses the server's master key as
 * an HMAC-SHA256 key — different cryptographic domain from envelope
 * encryption, so re-purposing the same bytes is safe. There is no server-
 * side state map: an attacker spamming `/oauth/start` can no longer evict
 * legitimate pending flows, and the OAuth flow scales horizontally without
 * sticky sessions.
 *
 * Single-use enforcement is delegated to Google: a state token is reusable
 * within its 10-minute TTL, but the OAuth `code` Google returns is single-
 * use on Google's side, so replay-with-original-code just gets a 400 from
 * the token endpoint.
 *
 * Note on the previously-flagged "session-fixation" concern: this OAuth
 * flow only stores Google refresh tokens keyed by `googleSubjectId` — it
 * does NOT establish a Margin session. Users authenticate to the Margin
 * API with `mgn_…` API tokens issued via CLI; the OAuth flow exists to
 * grant Drive access for a known user. A luring-into-callback attack
 * stores the *attacker's* Google credentials, not user impersonation.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

let cachedSigningKey: Promise<CryptoKey> | null = null;
function getSigningKey(): Promise<CryptoKey> {
  if (cachedSigningKey) return cachedSigningKey;
  cachedSigningKey = (async () => {
    const raw = Buffer.from(config.masterKeyB64, "base64");
    return crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  })();
  return cachedSigningKey;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(padded, "base64");
    // Copy into a fresh ArrayBuffer so the resulting view satisfies
    // SubtleCrypto's `BufferSource` constraint (Node's Buffer's underlying
    // storage is `ArrayBufferLike`, which TS rejects on `subtle.verify`).
    const ab = new ArrayBuffer(buf.length);
    const out = new Uint8Array(ab);
    out.set(buf);
    return out;
  } catch {
    return null;
  }
}

async function issueState(): Promise<string> {
  const payload = JSON.stringify({
    n: crypto.randomUUID(),
    exp: Date.now() + STATE_TTL_MS,
  });
  const payloadBytes = new TextEncoder().encode(payload);
  const payloadEncoded = base64UrlEncode(payloadBytes);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await getSigningKey(),
      new TextEncoder().encode(payloadEncoded),
    ),
  );
  return `${payloadEncoded}.${base64UrlEncode(sig)}`;
}

async function verifyState(state: string): Promise<boolean> {
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return false;
  const payloadEncoded = state.slice(0, dot);
  const sigEncoded = state.slice(dot + 1);
  const sig = base64UrlDecode(sigEncoded);
  if (!sig) return false;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await getSigningKey(),
    sig,
    new TextEncoder().encode(payloadEncoded),
  );
  if (!valid) return false;
  const payloadBytes = base64UrlDecode(payloadEncoded);
  if (!payloadBytes) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const exp = (parsed as { exp?: unknown }).exp;
  if (typeof exp !== "number") return false;
  return exp >= Date.now();
}

export async function handleOauthStart(_req: Request): Promise<Response> {
  const state = await issueState();
  const authUrl = buildAuthUrl({
    scopes: [...IDENTITY_SCOPES, DRIVE_SCOPES.drive_file],
    state,
    prompt: "consent",
  });
  return Response.redirect(authUrl, 302);
}

export async function handleOauthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return badRequest(`oauth error: ${error}`);
  if (!code || !state) return badRequest("missing code or state");

  if (!(await verifyState(state))) {
    return badRequest("invalid or expired state");
  }

  try {
    const { email, isNewUser } = await completeOAuth(code);
    // Success path stays as text — this URL is opened in a browser tab and
    // the user reads the message directly. JSON would be hostile UX.
    return new Response(
      `Connected ${email} as ${isNewUser ? "new" : "existing"} user. You can close this tab.\n`,
      { headers: { "content-type": "text/plain" } },
    );
  } catch (err) {
    console.error("oauth completion failed:", err);
    return internalError();
  }
}
