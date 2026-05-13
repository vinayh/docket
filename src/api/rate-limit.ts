// In-memory fixed-window rate limiter. Single-instance only — move to a shared store before scaling out.
// Better Auth has its own limiter on /api/auth/*; this covers everything else.

interface Bucket {
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
  resetSeconds: number;
}

export function checkRateLimit(key: string, limit: number = DEFAULT_LIMIT): RateLimitDecision {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  // Cap memory: when the map gets large, evict closed-window entries.
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
    }
  }

  const remaining = Math.max(0, limit - bucket.count);
  const resetSeconds = Math.max(0, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
  return { allowed: bucket.count <= limit, remaining, resetSeconds };
}

// Proxy headers are only honored when MARGIN_TRUST_PROXY=1 (Fly sets this; local dev doesn't).
// Without the gate, Fly-Client-IP / X-Forwarded-For would let a client pick any bucket key.
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

// Test-only: clear the in-memory bucket map between tests.
export function _resetRateLimitForTests(): void {
  buckets.clear();
}
