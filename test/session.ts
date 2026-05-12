import { db } from "../src/db/client.ts";
import { session } from "../src/db/schema.ts";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Insert a Better Auth `session` row directly and return the raw token.
 * Test-only shortcut around the full OAuth dance — route tests want a
 * usable `Authorization: Bearer <token>` header without standing up a
 * Google provider. The bearer plugin re-signs whatever token the client
 * presents (see `node_modules/better-auth/dist/plugins/bearer/index.mjs`)
 * and falls through to `session.token` lookup, so any string committed
 * to the table here will authenticate.
 */
export async function issueTestSession(opts: {
  userId: string;
  ttlMs?: number;
}): Promise<{ token: string }> {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS));
  await db.insert(session).values({
    userId: opts.userId,
    token,
    expiresAt,
  });
  return { token };
}
