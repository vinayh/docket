import { describe, expect, test } from "bun:test";
import { corsHeaders, isAllowedOrigin, preflight, withCors } from "./cors.ts";

function reqWithOrigin(origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  return new Request("http://localhost/api/extension/doc-state", {
    method: "POST",
    headers,
  });
}

const CHROME_ID = "a".repeat(32);
const FIREFOX_UUID = "12345678-1234-1234-1234-1234567890ab";

describe("isAllowedOrigin", () => {
  test("accepts chrome-extension:// with a 32-char lowercase id", () => {
    expect(isAllowedOrigin(`chrome-extension://${CHROME_ID}`)).toBe(true);
  });

  test("accepts moz-extension:// with a UUID", () => {
    expect(isAllowedOrigin(`moz-extension://${FIREFOX_UUID}`)).toBe(true);
  });

  test("accepts localhost on any port", () => {
    expect(isAllowedOrigin("http://localhost")).toBe(true);
    expect(isAllowedOrigin("http://localhost:8787")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  test("rejects arbitrary https origins", () => {
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedOrigin("https://docs.google.com")).toBe(false);
  });

  test("rejects malformed extension origins", () => {
    expect(isAllowedOrigin("chrome-extension://short")).toBe(false);
    expect(isAllowedOrigin("chrome-extension://" + "A".repeat(32))).toBe(false); // uppercase
    expect(isAllowedOrigin("moz-extension://not-a-uuid")).toBe(false);
  });
});

describe("corsHeaders", () => {
  test("echoes the origin only when it's in the allow-list", () => {
    const headers = corsHeaders(reqWithOrigin(`chrome-extension://${CHROME_ID}`));
    expect(headers["access-control-allow-origin"]).toBe(
      `chrome-extension://${CHROME_ID}`,
    );
    expect(headers["vary"]).toBe("Origin");
  });

  test("omits Allow-Origin entirely for disallowed origins", () => {
    const headers = corsHeaders(reqWithOrigin("https://evil.example.com"));
    expect(headers["access-control-allow-origin"]).toBeUndefined();
    // The other CORS headers still ride along — they're harmless without ACAO.
    expect(headers["access-control-allow-methods"]).toContain("POST");
  });

  test("omits Allow-Origin when no Origin header is present", () => {
    const headers = corsHeaders(reqWithOrigin(null));
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("preflight + withCors", () => {
  test("preflight is 204 with allowed methods + headers", () => {
    const res = preflight(reqWithOrigin(`chrome-extension://${CHROME_ID}`));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      `chrome-extension://${CHROME_ID}`,
    );
  });

  test("withCors merges headers without dropping existing ones", () => {
    const inner = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "x-custom": "kept" },
    });
    const wrapped = withCors(
      reqWithOrigin(`chrome-extension://${CHROME_ID}`),
      inner,
    );
    expect(wrapped.headers.get("content-type")).toBe("application/json");
    expect(wrapped.headers.get("x-custom")).toBe("kept");
    expect(wrapped.headers.get("access-control-allow-origin")).toBe(
      `chrome-extension://${CHROME_ID}`,
    );
  });

  test("withCors does not leak Allow-Origin for disallowed origins", () => {
    const inner = new Response("ok", { status: 200 });
    const wrapped = withCors(reqWithOrigin("https://attacker.example"), inner);
    expect(wrapped.headers.get("access-control-allow-origin")).toBeNull();
  });
});
