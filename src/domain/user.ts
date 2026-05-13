import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { user } from "../db/schema.ts";

export type User = typeof user.$inferSelect;

export async function getUserByEmail(email: string): Promise<User | null> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1);
  return rows[0] ?? null;
}

/**
 * Look up a user's email by id. Returns null if the row is missing — callers
 * decide whether that's an error or a benign "no email known" outcome.
 */
export async function userEmailById(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

/**
 * Resolve an author email to a Margin user id, returning null when the email
 * is missing or no user exists for it. Use this for stamping `origin_user_id`
 * on canonical_comment rows whose author may or may not be a Margin user
 * (typical for cross-org comments and extension-captured replies).
 */
export async function userIdByEmail(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const u = await getUserByEmail(email);
  return u?.id ?? null;
}

export async function requireUserByEmail(email: string): Promise<User> {
  const u = await getUserByEmail(email);
  if (!u) throw new Error(`no user with email ${email}`);
  return u;
}

/**
 * The first user inserted into the DB. Useful for single-tenant CLI flows
 * where the operator hasn't bothered to specify `--user`. Returns null if
 * no users have connected yet — callers that need a value should use
 * `requireFirstUser`.
 */
export async function firstUser(): Promise<User | null> {
  const rows = await db.select().from(user).limit(1);
  return rows[0] ?? null;
}

export async function requireFirstUser(): Promise<User> {
  const u = await firstUser();
  if (!u) throw new Error("no user in db — run `bun margin connect` first");
  return u;
}

export async function resolveUserByEmailOrFirst(email?: string): Promise<User> {
  return email ? requireUserByEmail(email) : requireFirstUser();
}

/**
 * Look up a user by email, creating a minimal row if none exists. Used to add
 * an external reviewer to a review_request before they've signed in to Margin
 * — they redeem the magic link with email-only identity (SPEC §8), so the
 * `account`/refresh-token rows stay absent until they actually sign in via
 * Better Auth. The placeholder name comes from the local-part of the email
 * and is overwritten on first OAuth callback by Better Auth's user-info sync.
 */
export async function getOrCreateUserByEmail(email: string): Promise<User> {
  const existing = await getUserByEmail(email);
  if (existing) return existing;
  const placeholderName = email.split("@")[0] ?? email;
  const inserted = await db
    .insert(user)
    .values({ email, name: placeholderName })
    .returning();
  return inserted[0]!;
}
