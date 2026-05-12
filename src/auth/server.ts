import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { db } from "../db/client.ts";
import { account, session, user, verification } from "../db/schema.ts";
import { config } from "../config.ts";
import { encryptWithMaster } from "./encryption.ts";

/**
 * Better Auth instance. Owns `/api/auth/*` (sign-in, callback, session
 * lookup) and the four standard tables `user`, `session`, `account`, and
 * `verification`. Bearer plugin lets the extension authenticate via
 * `Authorization: Bearer <session_token>` instead of cookies — the SW
 * acquires its token through `chrome.identity.launchWebAuthFlow` (see
 * `surfaces/extension/entrypoints/background.ts`).
 *
 * Google refresh tokens stored on `account.refreshToken` are envelope-
 * encrypted on write by the `databaseHooks.account` hook below; the
 * `TokenProvider` in `credentials.ts` decrypts them on read and refreshes
 * Drive access tokens directly against Google's token endpoint (Better
 * Auth's own refresh path is unused).
 */
export const auth = betterAuth({
  appName: "margin",
  baseURL: config.publicBaseUrl ?? "http://localhost:8787",
  basePath: "/api/auth",
  secret: config.betterAuthSecret,
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: { user, session, account, verification },
  }),
  socialProviders: {
    google: {
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      // Long-lived refresh token + force consent so we always receive one
      // (Google only returns refresh_token on the first consent unless we
      // pass prompt=consent). The provider also appends
      // `include_granted_scopes=true` automatically so adding scopes later
      // (e.g. gmail.send for review notifications) doesn't force re-consent
      // on drive.file.
      accessType: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/drive.file"],
    },
  },
  plugins: [bearer()],
  trustedOrigins: [
    config.publicBaseUrl,
    "http://localhost:8787",
    "http://127.0.0.1:8787",
  ].filter((u): u is string => Boolean(u)),
  databaseHooks: {
    account: {
      create: { before: encryptAccountRefreshToken },
      update: { before: encryptAccountRefreshToken },
    },
  },
});

/**
 * Better Auth `account.{create,update}.before` hook. Envelope-encrypts the
 * Google refresh token before it lands in `account.refresh_token`. Exported
 * so a unit test can verify the plaintext-in / ciphertext-out round trip
 * without standing up Better Auth's full social flow — this hook is the
 * only thing standing between a plaintext refresh token and disk.
 */
export async function encryptAccountRefreshToken<T extends { refreshToken?: string | null | undefined }>(
  data: T,
): Promise<{ data: T }> {
  if (typeof data.refreshToken === "string" && data.refreshToken.length > 0) {
    return {
      data: { ...data, refreshToken: await encryptWithMaster(data.refreshToken) },
    };
  }
  return { data };
}

export type Auth = typeof auth;
