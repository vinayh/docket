import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { driveCredential } from "../db/schema.ts";
import { decryptWithMaster, encryptWithMaster } from "./encryption.ts";
import { refreshAccessToken } from "../google/oauth.ts";
import type { TokenProvider } from "../google/api.ts";

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

const SAFETY_MARGIN_MS = 60_000;

async function loadRefreshToken(userId: string): Promise<string> {
  const rows = await db
    .select({ encrypted: driveCredential.refreshTokenEncrypted })
    .from(driveCredential)
    .where(eq(driveCredential.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`no drive credential for user ${userId}`);
  return decryptWithMaster(row.encrypted);
}

/**
 * Memoize providers by userId so the cached access token is shared across
 * every call site for that user. Without this, each `tokenProviderForUser`
 * caller (createVersion, ingestVersionComments, reanchor, …) built its own
 * closure and refreshed from scratch on first use, multiplying Google
 * `oauth2/token` round-trips.
 *
 * Cache holds the closure, not the access token directly — refresh state
 * still lives in the closure, so two concurrent calls for the same user
 * dedup through the existing `inflight` promise.
 */
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

/**
 * Drop a cached provider — call from tests that reset DB state with the same
 * userId, or from `storeRefreshToken` when a fresh refresh token arrives. In
 * normal operation the cache is fine to leave warm; access tokens that
 * outlive their refresh token still work until they expire.
 */
export function evictTokenProvider(userId: string): void {
  tpCache.delete(userId);
}

export async function storeRefreshToken(opts: {
  userId: string;
  refreshToken: string;
  scope: string;
}): Promise<void> {
  const refreshTokenEncrypted = await encryptWithMaster(opts.refreshToken);
  const existing = await db
    .select({ id: driveCredential.id })
    .from(driveCredential)
    .where(eq(driveCredential.userId, opts.userId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(driveCredential)
      .set({
        refreshTokenEncrypted,
        scope: opts.scope,
        updatedAt: new Date(),
      })
      .where(eq(driveCredential.id, existing[0].id));
  } else {
    await db.insert(driveCredential).values({
      userId: opts.userId,
      scope: opts.scope,
      refreshTokenEncrypted,
    });
  }

  // A cached provider for this user is now bound to a stale refresh token.
  // The cached access token might still be valid, but discarding the closure
  // forces the next caller to load the new refresh token from the DB.
  evictTokenProvider(opts.userId);
}
