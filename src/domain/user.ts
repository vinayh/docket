import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { user } from "../db/schema.ts";

export type User = typeof user.$inferSelect;

export async function getUserByEmail(email: string): Promise<User | null> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1);
  return rows[0] ?? null;
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
  if (!u) throw new Error("no user in db — run `bun docket connect` first");
  return u;
}

export async function resolveUserByEmailOrFirst(email?: string): Promise<User> {
  return email ? requireUserByEmail(email) : requireFirstUser();
}
