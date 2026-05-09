import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { apiToken } from "../db/schema.ts";

export const TOKEN_PREFIX = "dkt_";
const RANDOM_BYTES = 32;
const PREVIEW_TAIL = 4;

export type ApiTokenRow = typeof apiToken.$inferSelect;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hashToken(plaintext: string): string {
  return new Bun.CryptoHasher("sha256").update(plaintext).digest("hex");
}

function previewOf(plaintext: string): string {
  // "dkt_AbCd…wXyZ" — enough to disambiguate without leaking the secret.
  const tail = plaintext.slice(-PREVIEW_TAIL);
  return `${TOKEN_PREFIX}…${tail}`;
}

export interface IssuedToken {
  /** Plaintext token. Shown to the user exactly once; not persisted. */
  token: string;
  row: ApiTokenRow;
}

export async function issueApiToken(opts: {
  userId: string;
  label?: string;
}): Promise<IssuedToken> {
  const random = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  const token = `${TOKEN_PREFIX}${toBase64Url(random)}`;
  const inserted = await db
    .insert(apiToken)
    .values({
      userId: opts.userId,
      tokenHash: hashToken(token),
      tokenPreview: previewOf(token),
      label: opts.label ?? null,
    })
    .returning();
  return { token, row: inserted[0]! };
}

export interface VerifiedToken {
  userId: string;
  tokenId: string;
}

/**
 * Look up a presented token. Returns null if the token is unknown or revoked.
 * Bumps `last_used_at` on success — best-effort, never blocks the caller on
 * its result.
 */
export async function verifyApiToken(plaintext: string): Promise<VerifiedToken | null> {
  if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX)) return null;
  const rows = await db
    .select({
      id: apiToken.id,
      userId: apiToken.userId,
      revokedAt: apiToken.revokedAt,
    })
    .from(apiToken)
    .where(eq(apiToken.tokenHash, hashToken(plaintext)))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return null;

  void db
    .update(apiToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiToken.id, row.id))
    .catch((err) => {
      // Best-effort: a write failure here shouldn't bounce the API request,
      // but staying silent hides DB issues. Log and move on.
      console.warn(`api_token ${row.id}: last_used_at update failed:`, err);
    });

  return { userId: row.userId, tokenId: row.id };
}

export async function listApiTokens(userId: string): Promise<ApiTokenRow[]> {
  return db
    .select()
    .from(apiToken)
    .where(and(eq(apiToken.userId, userId), isNull(apiToken.revokedAt)))
    .orderBy(desc(apiToken.createdAt));
}

export async function revokeApiToken(tokenId: string): Promise<boolean> {
  const result = await db
    .update(apiToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiToken.id, tokenId), isNull(apiToken.revokedAt)))
    .returning({ id: apiToken.id });
  return result.length > 0;
}
