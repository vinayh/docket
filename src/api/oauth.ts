import { buildAuthUrl, DRIVE_SCOPES, IDENTITY_SCOPES } from "../google/oauth.ts";
import { completeOAuth } from "../auth/connect.ts";

/**
 * In-memory state store for OAuth flows. Single-process is fine because
 * Phase-2 deploys run a single Fly machine (min_machines_running=1, no
 * horizontal scale-out). When that changes, move state into the DB or
 * sign it as a JWT in a cookie.
 */
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, number>();

function purgeExpired(now = Date.now()): void {
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt < now) pendingStates.delete(state);
  }
}

export function handleOauthStart(_req: Request): Response {
  purgeExpired();
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now() + STATE_TTL_MS);

  const authUrl = buildAuthUrl({
    scopes: [...IDENTITY_SCOPES, DRIVE_SCOPES.drive_file],
    state,
    prompt: "consent",
  });
  return Response.redirect(authUrl, 302);
}

export async function handleOauthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`oauth error: ${error}`, { status: 400 });
  }
  if (!code || !state) {
    return new Response("missing code or state", { status: 400 });
  }

  purgeExpired();
  const expiresAt = pendingStates.get(state);
  if (expiresAt === undefined) {
    return new Response("invalid or expired state", { status: 400 });
  }
  pendingStates.delete(state);

  try {
    const { email, isNewUser } = await completeOAuth(code);
    return new Response(
      `Connected ${email} as ${isNewUser ? "new" : "existing"} user. You can close this tab.\n`,
      { headers: { "content-type": "text/plain" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`oauth completion failed: ${message}\n`, { status: 500 });
  }
}
