import { auth } from "../auth/server.ts";
import { db } from "../db/client.ts";
import { session as sessionTable } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { badRequest } from "./middleware.ts";

/**
 * Catch-all for `/api/auth/**`. Better Auth's `auth.handler` reads the basePath
 * (`/api/auth`) off the request URL and dispatches to its internal route
 * registry — sign-in, social-provider callback, get-session, sign-out, etc.
 */
export function handleAuthRequest(req: Request): Response | Promise<Response> {
  return auth.handler(req);
}

/**
 * Allowed extension callback origins for the MV3 `launchWebAuthFlow` flow.
 * Chrome / Edge use `chrome-extension://<id>.chromiumapp.org`; Firefox uses
 * `<uuid>.extensions.allizom.org` (the WebExtension polyfill maps it
 * similarly). We gate redirects against this allow-list so the launch /
 * finalize endpoints can't be turned into open redirectors.
 */
const EXT_CALLBACK_PATTERNS: readonly RegExp[] = [
  /^https:\/\/[a-z]{32}\.chromiumapp\.org\/[^\s]*$/,
  /^https:\/\/[0-9a-fA-F-]{36}\.extensions\.allizom\.org\/[^\s]*$/,
];

function isAllowedExtCallback(url: string): boolean {
  return EXT_CALLBACK_PATTERNS.some((p) => p.test(url));
}

/**
 * GET /api/auth/ext/launch?cb=<chromiumapp.org URL>
 *
 * Kicks off Google sign-in for the MV3 extension. Calls Better Auth's
 * `signInSocial` to mint the Google authorization URL (and the
 * accompanying PKCE/state cookies), then 302s the browser to it. The
 * inner `callbackURL` points back at `/api/auth/ext/finalize`, which is
 * what gets hit after Google → `/api/auth/callback/google` → session
 * creation.
 *
 * Chrome's `chrome.identity.launchWebAuthFlow` runs in an isolated cookie
 * jar that follows top-level HTTP redirects, so the state + session
 * cookies flow correctly from launch → Google → callback → finalize →
 * extension.
 */
export async function handleAuthExtLaunch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cb = url.searchParams.get("cb");
  if (!cb || !isAllowedExtCallback(cb)) {
    return badRequest("missing or unrecognized ?cb extension callback url");
  }

  const baseURL = new URL(req.url);
  baseURL.search = "";
  baseURL.pathname = "/api/auth/ext/finalize";
  const finalizeURL = `${baseURL.toString()}?cb=${encodeURIComponent(cb)}`;

  const res = await auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL: finalizeURL,
      disableRedirect: true,
    },
    asResponse: true,
  });

  const body = (await res.json()) as { url?: string };
  if (!res.ok || !body.url) {
    return new Response("sign-in init failed", { status: 502 });
  }

  const redirect = new Response(null, {
    status: 302,
    headers: { location: body.url },
  });
  for (const [k, v] of res.headers.entries()) {
    if (k.toLowerCase() === "set-cookie") redirect.headers.append("set-cookie", v);
  }
  return redirect;
}

/**
 * GET /api/auth/ext/finalize?cb=<chromiumapp.org URL>
 *
 * After Better Auth's social callback creates the session and sets its
 * cookie, the user lands here. Look up the session via the cookie,
 * fetch the raw `session.token` from the DB (the bearer plugin accepts
 * the unsigned form and re-signs it on each request), and 302 to the
 * extension's chromiumapp.org callback URL with `#token=<sessionToken>`
 * as a URL fragment. `chrome.identity.launchWebAuthFlow` returns the
 * complete URL (fragment included) to the SW, which parses `hash` and
 * persists the token in `chrome.storage.local`.
 *
 * Why the fragment instead of a query param: chromiumapp.org has no
 * DNS, so the redirect target is never actually fetched — Chrome
 * intercepts it. But the 302 response carrying the token still travels
 * back over TLS and lands briefly in `launchWebAuthFlow`'s callback
 * arg; using a fragment keeps it strictly client-side per the URL
 * spec, so even a (mis)configured reverse-proxy access log that
 * records full URLs of intercepted callbacks won't see the token.
 */
export async function handleAuthExtFinalize(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cb = url.searchParams.get("cb");
  if (!cb || !isAllowedExtCallback(cb)) {
    return badRequest("missing or unrecognized ?cb extension callback url");
  }

  const result = await auth.api.getSession({ headers: req.headers });
  if (!result) {
    return new Response("sign-in did not produce a session", { status: 401 });
  }

  const rows = await db
    .select({ token: sessionTable.token })
    .from(sessionTable)
    .where(eq(sessionTable.id, result.session.id))
    .limit(1);
  const token = rows[0]?.token;
  if (!token) {
    return new Response("session row missing", { status: 500 });
  }

  const dest = new URL(cb);
  // Preserve any existing fragment on the callback URL by merging — there
  // shouldn't be one (we allow-list the format), but be defensive.
  const existing = dest.hash.startsWith("#") ? dest.hash.slice(1) : dest.hash;
  const fragment = existing.length > 0
    ? `${existing}&token=${encodeURIComponent(token)}`
    : `token=${encodeURIComponent(token)}`;
  dest.hash = fragment;
  return new Response(null, { status: 302, headers: { location: dest.toString() } });
}
