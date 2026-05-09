import { afterEach, describe, expect, test } from "bun:test";
import { setFetch } from "../../test/fetch.ts";
import {
  GoogleApiError,
  authedFetch,
  authedJson,
  type TokenProvider,
} from "./api.ts";

/**
 * Tiny token-provider stub that records refresh invocations so tests can
 * assert "this triggered exactly one refresh" without leaking timing.
 */
function makeTokenProvider(
  initial = "access-1",
  refreshed = "access-2",
): TokenProvider & { refreshes: number; current: string } {
  const tp = {
    refreshes: 0,
    current: initial,
    async getAccessToken() {
      return tp.current;
    },
    async refreshAccessToken() {
      tp.refreshes += 1;
      tp.current = refreshed;
      return tp.current;
    },
  };
  return tp;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("authedFetch", () => {
  test("attaches Bearer header and returns the response on a 200", async () => {
    const tp = makeTokenProvider();
    const calls: { url: string; auth: string | null }[] = [];
    setFetch(async (input, init) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response("ok", { status: 200 });
    });

    const res = await authedFetch(tp, "https://example.com/x");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe("Bearer access-1");
    expect(tp.refreshes).toBe(0);
  });

  test("on 401, refreshes the token and retries exactly once", async () => {
    const tp = makeTokenProvider();
    const seen: string[] = [];
    setFetch(async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(auth);
      return seen.length === 1
        ? new Response(null, { status: 401 })
        : new Response("ok", { status: 200 });
    });

    const res = await authedFetch(tp, "https://example.com/x");
    expect(res.status).toBe(200);
    expect(tp.refreshes).toBe(1);
    expect(seen).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  test("a second 401 after refresh is surfaced verbatim (no infinite loop)", async () => {
    const tp = makeTokenProvider();
    let n = 0;
    setFetch(async () => {
      n += 1;
      return new Response("nope", { status: 401 });
    });

    const res = await authedFetch(tp, "https://example.com/x");
    expect(res.status).toBe(401);
    expect(n).toBe(2); // attempt + retry, no third call
    expect(tp.refreshes).toBe(1);
  });

  test("preserves caller-supplied headers and method", async () => {
    const tp = makeTokenProvider();
    let captured: { method?: string; ct: string | null; auth: string | null } | null = null;
    setFetch(async (_input, init) => {
      const h = new Headers(init?.headers);
      captured = {
        method: init?.method,
        ct: h.get("content-type"),
        auth: h.get("authorization"),
      };
      return new Response("{}", { status: 200 });
    });

    await authedFetch(tp, "https://example.com/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.ct).toBe("application/json");
    expect(captured!.auth).toBe("Bearer access-1");
  });
});

describe("authedJson", () => {
  test("parses a JSON 200", async () => {
    const tp = makeTokenProvider();
    setFetch(async () =>
      new Response(JSON.stringify({ ok: true, n: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const out = await authedJson<{ ok: boolean; n: number }>(tp, "https://x");
    expect(out).toEqual({ ok: true, n: 7 });
  });

  test("throws GoogleApiError with status, url, and body on a non-OK", async () => {
    const tp = makeTokenProvider();
    setFetch(async () => new Response("rate limited", { status: 429 }));

    let caught: GoogleApiError | null = null;
    try {
      await authedJson(tp, "https://example.com/quota");
    } catch (err) {
      caught = err as GoogleApiError;
    }
    expect(caught).toBeInstanceOf(GoogleApiError);
    expect(caught?.status).toBe(429);
    expect(caught?.url).toBe("https://example.com/quota");
    expect(caught?.body).toBe("rate limited");
  });
});
