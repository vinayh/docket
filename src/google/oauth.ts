import { config } from "../config.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const DRIVE_SCOPES = {
  drive_file: "https://www.googleapis.com/auth/drive.file",
} as const;

export const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

export interface AuthUrlOptions {
  scopes: readonly string[];
  state: string;
  loginHint?: string;
  prompt?: "consent" | "none" | "select_account";
  redirectUri?: string;
}

export function buildAuthUrl(opts: AuthUrlOptions): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: opts.redirectUri ?? config.google.redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    state: opts.state,
    prompt: opts.prompt ?? "consent",
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_URL}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: "Bearer";
  id_token?: string;
}

export async function exchangeCode(code: string, redirectUri?: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri ?? config.google.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<TokenResponse>;
}

export interface UserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export async function getUserInfo(accessToken: string): Promise<UserInfo> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`userinfo failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<UserInfo>;
}
