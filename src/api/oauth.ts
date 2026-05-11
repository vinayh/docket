import { buildAuthUrl, DRIVE_SCOPES, IDENTITY_SCOPES } from "../google/oauth.ts";
import { completeOAuth } from "../auth/connect.ts";
import { badRequest, internalError } from "./middleware.ts";

/**
 * In-memory state store for OAuth flows. Single-process is fine because
 * Phase-2 deploys run a single Fly machine (min_machines_running=1, no
 * horizontal scale-out). When that changes, move state into the DB or
 * sign it as a JWT in a cookie.
 *
 * Size bound: `MAX_PENDING_STATES` caps growth so an unauthenticated flood
 * of `/oauth/start` calls can't exhaust memory in the 10-minute window
 * before `purgeExpired` runs. Eviction policy is FIFO by insertion order
 * (Map iteration is insertion-ordered) — the oldest state is dropped, which
 * just makes that flow's callback fail with "invalid or expired state".
 *
 * Note on the agent-flagged "session-fixation" concern: this OAuth flow
 * only stores Google refresh tokens keyed by `googleSubjectId` — it does
 * NOT establish a Margin session. Users authenticate to the Margin API
 * with `mgn_…` API tokens issued via CLI; the OAuth flow exists to grant
 * Drive access for a known user. So a luring-into-callback attack causes
 * the *attacker's* Google credentials to be stored, not user-impersonation.
 */
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 1024;
const pendingStates = new Map<string, number>();

function purgeExpired(now = Date.now()): void {
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt < now) pendingStates.delete(state);
  }
}

export function handleOauthStart(_req: Request): Response {
  purgeExpired();
  while (pendingStates.size >= MAX_PENDING_STATES) {
    // Drop the oldest (insertion-order iteration) to make room. A pending
    // flow we evict will fail at callback time, which is expected under
    // overload.
    const oldest = pendingStates.keys().next().value;
    if (oldest === undefined) break;
    pendingStates.delete(oldest);
  }
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

  if (error) return badRequest(`oauth error: ${error}`);
  if (!code || !state) return badRequest("missing code or state");

  // Atomic check-and-remove: `Map.delete` returns true iff the key existed,
  // which prevents two concurrent callbacks with the same state from both
  // passing the existence check and racing into `completeOAuth`. Then check
  // expiry inline (purgeExpired runs lazily, so the entry might be stale).
  const expiresAt = pendingStates.get(state);
  if (!pendingStates.delete(state)) return badRequest("invalid or expired state");
  if (expiresAt === undefined || expiresAt < Date.now()) {
    return badRequest("invalid or expired state");
  }

  try {
    const { email, isNewUser } = await completeOAuth(code);
    // Success path stays as text — this URL is opened in a browser tab and
    // the user reads the message directly. JSON would be hostile UX.
    return new Response(
      `Connected ${email} as ${isNewUser ? "new" : "existing"} user. You can close this tab.\n`,
      { headers: { "content-type": "text/plain" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return internalError(`oauth completion failed: ${message}`);
  }
}
