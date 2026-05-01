import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { user } from "../db/schema.ts";
import { exchangeCode, getUserInfo } from "../google/oauth.ts";
import { storeRefreshToken } from "./credentials.ts";

export interface ConnectResult {
  userId: string;
  email: string;
  isNewUser: boolean;
}

export async function completeOAuth(code: string, redirectUri?: string): Promise<ConnectResult> {
  const tokens = await exchangeCode(code, redirectUri);
  if (!tokens.refresh_token) {
    throw new Error(
      "no refresh_token returned. Re-run with prompt=consent or revoke prior consent at myaccount.google.com",
    );
  }

  const info = await getUserInfo(tokens.access_token);
  const homeOrg = info.email.includes("@") ? info.email.split("@")[1] : null;

  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.googleSubjectId, info.sub))
    .limit(1);

  let userId: string;
  let isNewUser = false;
  if (existing[0]) {
    userId = existing[0].id;
  } else {
    const inserted = await db
      .insert(user)
      .values({
        email: info.email,
        googleSubjectId: info.sub,
        displayName: info.name ?? null,
        homeOrg,
        authMethod: "google",
      })
      .returning({ id: user.id });
    userId = inserted[0]!.id;
    isNewUser = true;
  }

  await storeRefreshToken({
    userId,
    refreshToken: tokens.refresh_token,
    scope: tokens.scope,
  });

  return { userId, email: info.email, isNewUser };
}
