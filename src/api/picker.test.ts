import { describe, expect, test } from "bun:test";
import { handlePickerHost } from "./picker.ts";

describe("picker security headers", () => {
  const res = handlePickerHost(new Request("http://localhost/picker"));

  test("declares a Content-Security-Policy", () => {
    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    // Picker depends on Google's GIS + apis.google.com — both must be allowlisted
    // explicitly. If either gets dropped from script-src, the page won't load
    // its third-party JS and will silently fail at runtime.
    expect(csp).toContain("https://accounts.google.com");
    expect(csp).toContain("https://apis.google.com");
    // No clickjacking surface.
    expect(csp).toContain("frame-ancestors 'none'");
    // base-uri lockdown blocks injected `<base>` from rewriting relative URLs.
    expect(csp).toContain("base-uri 'self'");
  });

  test("sets Referrer-Policy: no-referrer", () => {
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("sets X-Content-Type-Options: nosniff", () => {
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("forbids caching the page", () => {
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
