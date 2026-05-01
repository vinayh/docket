import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { user } from "../db/schema.ts";

export type User = typeof user.$inferSelect;

export async function defaultUser(): Promise<User> {
  const rows = await db.select().from(user).limit(1);
  if (!rows[0]) {
    throw new Error("no user in db — run `bun docket connect` first");
  }
  return rows[0];
}

export async function userByEmail(email: string): Promise<User> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!rows[0]) throw new Error(`no user with email ${email}`);
  return rows[0];
}

export async function resolveUser(emailOrUndefined: string | undefined): Promise<User> {
  return emailOrUndefined ? userByEmail(emailOrUndefined) : defaultUser();
}

export function die(message: string): never {
  console.error(message);
  process.exit(1);
}
