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

export function tokenProviderForUser(userId: string): TokenProvider {
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
}
