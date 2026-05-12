/**
 * In-memory fixed-window rate limiter for the bearer-authenticated extension
 * + picker routes. Margin runs as a single-instance Fly app, so a process-
 * local map is sufficient; if we ever horizontally scale this needs to move
 * into the DB or a shared store.
 *
 * Keying: prefer the authenticated user id ("u:<id>"), fall back to the
 * client IP ("ip:<ip>") for routes that didn't authenticate. This means
 * an attacker can't spend an anonymous user's budget on a victim, and a
 * NAT'd group of legitimate users only share a budget while signed out.
 *
 * Better Auth has its own rate limiter on `/api/auth/*` (100 reqs / 10s by
 * default in production); this module is the equivalent for everything
 * else we expose.
 */

interface Bucket {
  /** Window start (ms since epoch). */
  windowStart: number;
  count: number;
}

const WINDOW_MS = 60 * 1000;
const DEFAULT_LIMIT = 120;
const MAX_BUCKETS = 10_000;

const buckets = new Map<string, Bucket>();

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  resetSeconds: number;
}

/**
 * Increment the bucket for `key` against `limit` requests per
 * `WINDOW_MS`. Returns whether the call may proceed and how many slots
 * remain in the current window. Side-effect-only when over budget — the
 * caller decides how to respond (we surface 429 + `Retry-After`).
 */
export function checkRateLimit(key: string, limit: number = DEFAULT_LIMIT): RateLimitDecision {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  // Cheap unbounded-growth guard: when the map gets large, evict every
  // entry whose window has already closed. This runs at most once per call
  // and only when the population threshold is crossed.
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
    }
  }

  const remaining = Math.max(0, limit - bucket.count);
  const resetSeconds = Math.max(0, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
  return { allowed: bucket.count <= limit, remaining, resetSeconds };
}

/**
 * Extract a stable client identifier from the request.
 *
 * Header trust is gated on `MARGIN_TRUST_PROXY=1` — without an upstream
 * proxy the `Fly-Client-IP` / `X-Forwarded-For` headers are
 * attacker-controlled, so spoofing them would let a client pick any bucket
 * key they liked. The Fly deployment sets that env; local dev doesn't.
 *
 * Trusted-proxy mode: `Fly-Client-IP`, then first hop of `X-Forwarded-For`.
 * Untrusted mode (default): socket address from `server.requestIP(req)`.
 *
 * Returns the literal "unknown" so a malformed request still gets bucketed
 * (rather than bypassing the limiter entirely).
 */
export function clientIp(
  req: Request,
  opts: { server?: { requestIP(req: Request): { address: string } | null }; trustProxy: boolean },
): string {
  if (opts.trustProxy) {
    const fly = req.headers.get("fly-client-ip");
    if (fly && fly.length <= 64) return fly;
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first && first.length <= 64) return first;
    }
  }
  const socket = opts.server?.requestIP(req);
  if (socket?.address && socket.address.length <= 64) return socket.address;
  return "unknown";
}

/** Test-only — clear the in-memory bucket map between tests. */
export function _resetRateLimitForTests(): void {
  buckets.clear();
}
