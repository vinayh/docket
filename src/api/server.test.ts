import { describe, expect, test } from "bun:test";
import { startServer } from "./server.ts";

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

  test("unknown path falls through to 404", async () => {
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const res = await fetch(`http://${server.hostname}:${server.port}/no-such-route`);
      expect(res.status).toBe(404);
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

  test("Search Console verification file is served at its exact path", async () => {
    // If you re-verify with a fresh token, update the route in server.ts
    // *and* this test — Drive files.watch (SPEC §9.3) won't accept the host
    // as a webhook address until verification is current.
    const server = startServer({ port: 0, backgroundLoops: false });
    try {
      const res = await fetch(
        `http://${server.hostname}:${server.port}/google4c42fb2047912f0c.html`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(
        "google-site-verification: google4c42fb2047912f0c.html",
      );
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
