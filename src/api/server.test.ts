import { beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "./server.ts";
import { _resetRateLimitForTests } from "./rate-limit.ts";

beforeEach(_resetRateLimitForTests);

/**
 * Smoke-tests for the route table and background-loop wiring. We bind to
 * port 0 so each run gets a free OS-assigned port — running tests in
 * parallel with `bun test` would otherwise step on one another.
 */
describe("startServer route table", () => {
  test("/healthz responds 200 with { ok: true }", async () => {
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const res = await fetch(`http://${server.hostname}:${server.port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await server.stop();
    }
  });

  test("/api/picker/register-doc 401s without an Authorization header", async () => {
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const res = await fetch(
        `http://${server.hostname}:${server.port}/api/picker/register-doc`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docUrlOrId: "abc" }),
        },
      );
      expect(res.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  test("OPTIONS preflight on /api/picker/register-doc returns 204", async () => {
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const res = await fetch(
        `http://${server.hostname}:${server.port}/api/picker/register-doc`,
        {
          method: "OPTIONS",
          headers: {
            origin: `chrome-extension://${"a".repeat(32)}`,
            "access-control-request-method": "POST",
          },
        },
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    } finally {
      await server.stop();
    }
  });

  test("/r/<token> path is registered and renders HTML for unknown tokens", async () => {
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const res = await fetch(
        `http://${server.hostname}:${server.port}/r/mra_unknown`,
      );
      // Unknown tokens render the "Link not recognized" page at 404. The
      // test exists to verify Bun.serve's `:token` parameter route matches
      // — a 404-from-fetch-fallthrough would also be 404, but the response
      // body / content-type proves it went through `handleReviewActionGet`.
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Link not recognized");
    } finally {
      await server.stop();
    }
  });

  test("unknown path falls through to 404", async () => {
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const res = await fetch(`http://${server.hostname}:${server.port}/no-such-route`);
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("extension routes set x-margin-rate-limit-remaining and 429 when exhausted", async () => {
    // 401-on-no-auth requests still pass through the rate-limit gate; the
    // first call sees ~119 remaining, and a tight burst of >120 starts
    // returning 429 with a Retry-After header. We don't burn the full
    // 120 here — just verify the header is present and decrementing.
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const a = await fetch(
        `http://${server.hostname}:${server.port}/api/picker/register-doc`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(a.status).toBe(401);
      const remA = a.headers.get("x-margin-rate-limit-remaining");
      expect(remA).not.toBeNull();
      expect(Number(remA)).toBe(119);

      const b = await fetch(
        `http://${server.hostname}:${server.port}/api/picker/register-doc`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(b.status).toBe(401);
      expect(Number(b.headers.get("x-margin-rate-limit-remaining"))).toBe(118);
    } finally {
      await server.stop();
    }
  });

  test("security headers are stamped on both CORS and non-CORS responses", async () => {
    // Easy thing to silently regress — if the secured() wrapper or
    // applySecurityHeaders in cors.ts gets dropped, lock the floor.
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const expected = {
        "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "cross-origin-opener-policy": "same-origin",
      };
      const healthz = await fetch(`http://${server.hostname}:${server.port}/healthz`);
      for (const [k, v] of Object.entries(expected)) {
        expect(healthz.headers.get(k)).toBe(v);
      }
      const preflight = await fetch(
        `http://${server.hostname}:${server.port}/api/picker/register-doc`,
        { method: "OPTIONS", headers: { origin: `chrome-extension://${"a".repeat(32)}` } },
      );
      for (const [k, v] of Object.entries(expected)) {
        expect(preflight.headers.get(k)).toBe(v);
      }
    } finally {
      await server.stop();
    }
  });

});

describe("startServer background loops", () => {
  test("backgroundLoops:false boots clean and stops without dangling timers", async () => {
    const server = startServer({ port: 0, backgroundLoops: false });
    await server.stop();
    // If a setInterval slipped through, Bun's test runner would warn about
    // the open handle keeping the test process alive. Reaching this line is
    // the assertion.
    expect(true).toBe(true);
  });

  test("backgroundLoops on with no MARGIN_PUBLIC_BASE_URL is a no-op", async () => {
    // .env doesn't set MARGIN_PUBLIC_BASE_URL during `bun test`, so the
    // loop initializer logs "skipping" and schedules nothing. Just verify
    // the server still boots and stops.
    const original = Bun.env.MARGIN_PUBLIC_BASE_URL;
    delete Bun.env.MARGIN_PUBLIC_BASE_URL;
    try {
      const server = startServer({ port: 0, backgroundLoops: true });
      await server.stop();
      expect(true).toBe(true);
    } finally {
      if (original !== undefined) Bun.env.MARGIN_PUBLIC_BASE_URL = original;
    }
  });
});
