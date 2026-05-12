import { config } from "../config.ts";

/**
 * Google's OAuth2 token endpoint. Used by `TokenProvider` to refresh access
 * tokens off the long-lived refresh tokens stored in `account.refreshToken`
 * (see `src/auth/credentials.ts`). The authorization URL and code exchange
 * live inside Better Auth's Google social provider — see `src/auth/server.ts`.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: "Bearer";
  id_token?: string;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
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
  return res.json() as Promise<TokenResponse>;
}
