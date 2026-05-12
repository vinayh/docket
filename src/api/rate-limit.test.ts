import { beforeEach, describe, expect, test } from "bun:test";
import { _resetRateLimitForTests, checkRateLimit, clientIp } from "./rate-limit.ts";

describe("checkRateLimit", () => {
  beforeEach(_resetRateLimitForTests);

  test("first call returns allowed with limit-1 remaining", () => {
    const r = checkRateLimit("u:alice", 5);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(r.resetSeconds).toBeGreaterThan(0);
    expect(r.resetSeconds).toBeLessThanOrEqual(60);
  });

  test("blocks once limit is exceeded", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("u:bob", 5).allowed).toBe(true);
    }
    const r = checkRateLimit("u:bob", 5);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  test("buckets are independent across keys", () => {
    // Burn alice's budget; bob should still be fine.
    for (let i = 0; i < 5; i++) checkRateLimit("u:alice", 5);
    expect(checkRateLimit("u:alice", 5).allowed).toBe(false);
    expect(checkRateLimit("u:bob", 5).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  test("trusted-proxy mode prefers fly-client-ip", () => {
    const req = new Request("http://x/", {
      headers: { "fly-client-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" },
    });
    expect(clientIp(req, { trustProxy: true })).toBe("1.2.3.4");
  });

  test("trusted-proxy mode falls back to x-forwarded-for (first hop)", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(clientIp(req, { trustProxy: true })).toBe("1.2.3.4");
  });

  test("untrusted mode ignores proxy headers and uses the socket address", () => {
    const req = new Request("http://x/", {
      headers: { "fly-client-ip": "spoofed", "x-forwarded-for": "spoofed2" },
    });
    const server = {
      requestIP: () => ({ address: "10.0.0.1" }),
    };
    expect(clientIp(req, { trustProxy: false, server })).toBe("10.0.0.1");
  });

  test("returns the literal 'unknown' when no source is available", () => {
    expect(clientIp(new Request("http://x/"), { trustProxy: false })).toBe("unknown");
  });
});
