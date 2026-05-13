import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { account } from "../db/schema.ts";
import { decryptWithMaster } from "./encryption.ts";
import { config } from "../config.ts";
import type { TokenProvider } from "../google/api.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
}

async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<GoogleTokenResponse>;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

const SAFETY_MARGIN_MS = 60_000;
const GOOGLE_PROVIDER_ID = "google";

async function loadRefreshToken(userId: string): Promise<string> {
  const rows = await db
    .select({ refreshToken: account.refreshToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, GOOGLE_PROVIDER_ID)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.refreshToken) {
    throw new Error(`no google account credential for user ${userId}`);
  }
  return decryptWithMaster(row.refreshToken);
}

// Memoize per user so the cached access token + inflight refresh are shared across callers.
const tpCache = new Map<string, TokenProvider>();

export function tokenProviderForUser(userId: string): TokenProvider {
  const hit = tpCache.get(userId);
  if (hit) return hit;
  const tp = buildTokenProvider(userId);
  tpCache.set(userId, tp);
  return tp;
}

function buildTokenProvider(userId: string): TokenProvider {
  let cached: CachedAccessToken | null = null;
  let inflight: Promise<string> | null = null;

  const refresh = (): Promise<string> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const refreshToken = await loadRefreshToken(userId);
        const r = await refreshAccessToken(refreshToken);
        cached = {
          token: r.access_token,
          expiresAt: Date.now() + r.expires_in * 1000 - SAFETY_MARGIN_MS,
        };
        return r.access_token;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    async getAccessToken() {
      if (cached && Date.now() < cached.expiresAt) return cached.token;
      return refresh();
    },
    async refreshAccessToken() {
      cached = null;
      return refresh();
    },
  };
}

